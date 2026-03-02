import pandas as pd
import numpy as np
import json
from scipy import stats

# Read data
df = pd.read_csv("/data/input.csv")

# Parse date
df['date'] = pd.to_datetime(df['date'])
df['year_month'] = df['date'].dt.to_period('M').astype(str)
df['year'] = df['date'].dt.year

# Clean numeric columns
numeric_cols = ['n_rides_lyftnav', 'n_drivers_lyftnav', 'battery_delta', 'nav_hours',
                'n_rides_lyftnav_not_full_charging', 'n_drivers_lyftnav_not_full_charging',
                'battery_delta_not_full_charging', 'nav_hours_not_full_charging']
for col in numeric_cols:
    df[col] = pd.to_numeric(df[col], errors='coerce')

# Extract OS and nav provider from os_infotainment
df['os'] = df['os_infotainment'].str.extract(r'^(\w+)\s*\(')
df['nav_provider'] = df['os_infotainment'].str.extract(r'\(([^)]+)\)')

# Charging compliance
df['compliance_rate'] = np.where(
    df['n_rides_lyftnav'] > 0,
    df['n_rides_lyftnav_not_full_charging'] / df['n_rides_lyftnav'],
    np.nan
)

# Battery per nav hour
df['battery_per_nav_hour'] = np.where(
    df['nav_hours'] > 0,
    df['battery_delta'] / df['nav_hours'],
    np.nan
)

# Battery per ride
df['battery_per_ride'] = np.where(
    df['n_rides_lyftnav'] > 0,
    df['battery_delta'] / df['n_rides_lyftnav'],
    np.nan
)

def clean_val(v):
    """Convert a value to JSON-safe type."""
    if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
        return None
    return v

def clean_list(lst):
    return [clean_val(v) for v in lst]

def clean_records(records):
    cleaned = []
    for rec in records:
        new_rec = {}
        for k, v in rec.items():
            if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
                new_rec[k] = None
            else:
                new_rec[k] = v
        cleaned.append(new_rec)
    return cleaned

# ─── 1. Usage by Nav Provider ───────────────────────────────────────────────
nav_usage = df.groupby('nav_provider').agg(
    total_rides=('n_rides_lyftnav', 'sum'),
    total_drivers=('n_drivers_lyftnav', 'sum'),
    total_nav_hours=('nav_hours', 'sum'),
    total_battery_delta=('battery_delta', 'sum'),
    avg_compliance_rate=('compliance_rate', 'mean'),
    record_count=('n_rides_lyftnav', 'count')
).reset_index()
nav_usage['avg_battery_per_hour'] = nav_usage['total_battery_delta'] / nav_usage['total_nav_hours']

# ─── 2. Usage by OS ──────────────────────────────────────────────────────────
os_usage = df.groupby('os').agg(
    total_rides=('n_rides_lyftnav', 'sum'),
    total_drivers=('n_drivers_lyftnav', 'sum'),
    total_nav_hours=('nav_hours', 'sum'),
    total_battery_delta=('battery_delta', 'sum'),
    avg_compliance_rate=('compliance_rate', 'mean'),
    record_count=('n_rides_lyftnav', 'count')
).reset_index()

# ─── 3. Usage by os_infotainment ───────────────────────────────────────────
full_usage = df.groupby('os_infotainment').agg(
    total_rides=('n_rides_lyftnav', 'sum'),
    total_drivers=('n_drivers_lyftnav', 'sum'),
    total_nav_hours=('nav_hours', 'sum'),
    total_battery_delta=('battery_delta', 'sum'),
    avg_compliance_rate=('compliance_rate', 'mean'),
    record_count=('n_rides_lyftnav', 'count')
).reset_index()
full_usage['avg_battery_per_hour'] = full_usage['total_battery_delta'] / full_usage['total_nav_hours']

# ─── 4. Charging Status breakdown ───────────────────────────────────────────
charging_usage = df.dropna(subset=['charging_status']).groupby('charging_status').agg(
    total_rides=('n_rides_lyftnav', 'sum'),
    total_drivers=('n_drivers_lyftnav', 'sum'),
    total_battery_delta=('battery_delta', 'sum'),
    total_nav_hours=('nav_hours', 'sum'),
    avg_compliance_rate=('compliance_rate', 'mean'),
    record_count=('n_rides_lyftnav', 'count')
).reset_index()

# ─── 5. Monthly trend by nav_provider ───────────────────────────────────────
monthly_nav = df.groupby(['year_month', 'nav_provider']).agg(
    total_rides=('n_rides_lyftnav', 'sum'),
    total_nav_hours=('nav_hours', 'sum'),
    total_battery_delta=('battery_delta', 'sum'),
    avg_compliance_rate=('compliance_rate', 'mean')
).reset_index().sort_values('year_month')

# ─── 6. Correlation Analysis ─────────────────────────────────────────────────
corr_cols = ['n_rides_lyftnav', 'n_drivers_lyftnav', 'battery_delta', 'nav_hours',
             'compliance_rate', 'battery_per_nav_hour', 'battery_per_ride']
corr_df = df[corr_cols].dropna()
corr_matrix = corr_df.corr()

corr_labels = ['Rides', 'Drivers', 'Battery Delta', 'Nav Hours',
               'Compliance Rate', 'Battery/Hour', 'Battery/Ride']

battery_corr = {}
for col in ['n_rides_lyftnav', 'n_drivers_lyftnav', 'nav_hours', 'compliance_rate', 'battery_per_nav_hour']:
    valid = df[['battery_delta', col]].dropna()
    if len(valid) > 2:
        r, p = stats.pearsonr(valid['battery_delta'], valid[col])
        r_val = None if (np.isnan(r) or np.isinf(r)) else round(float(r), 4)
        p_val = None if (np.isnan(p) or np.isinf(p)) else round(float(p), 6)
        battery_corr[col] = {'r': r_val, 'p_value': p_val}

compliance_corr = {}
for col in ['n_rides_lyftnav', 'n_drivers_lyftnav', 'nav_hours', 'battery_delta', 'battery_per_nav_hour']:
    valid = df[['compliance_rate', col]].dropna()
    if len(valid) > 2:
        r, p = stats.pearsonr(valid['compliance_rate'], valid[col])
        r_val = None if (np.isnan(r) or np.isinf(r)) else round(float(r), 4)
        p_val = None if (np.isnan(p) or np.isinf(p)) else round(float(p), 6)
        compliance_corr[col] = {'r': r_val, 'p_value': p_val}

# ─── 7. Scatter data ─────────────────────────────────────────────────────────
scatter_df = df[['nav_hours', 'battery_delta', 'nav_provider', 'compliance_rate', 'n_rides_lyftnav']].dropna()
scatter_df = scatter_df.sample(min(2000, len(scatter_df)), random_state=42)

# ─── 8. Compliance by charging_status and nav_provider ──────────────────────
compliance_by_charging = df.dropna(subset=['charging_status']).groupby(
    ['charging_status', 'nav_provider']
).agg(avg_compliance=('compliance_rate', 'mean'), count=('compliance_rate', 'count')).reset_index()

# ─── 9. Box plot data ────────────────────────────────────────────────────────
box_df = df[['nav_provider', 'battery_per_nav_hour', 'os', 'compliance_rate']].dropna()

# ─── 10. Summary stats ───────────────────────────────────────────────────────
avg_compliance = df['compliance_rate'].mean()
avg_compliance = None if (np.isnan(avg_compliance) or np.isinf(avg_compliance)) else round(float(avg_compliance), 4)

results = {
    "total_records": int(len(df)),
    "date_range": {"min": str(df['date'].min()), "max": str(df['date'].max())},
    "total_rides": int(df['n_rides_lyftnav'].sum()),
    "total_drivers": int(df['n_drivers_lyftnav'].sum()),
    "total_nav_hours": round(float(df['nav_hours'].sum()), 2),
    "total_battery_delta": round(float(df['battery_delta'].sum()), 2),
    "avg_compliance_rate": avg_compliance,
    "nav_providers": df['nav_provider'].dropna().unique().tolist(),
    "os_types": df['os'].dropna().unique().tolist(),
    "charging_statuses": df['charging_status'].dropna().unique().tolist(),
    "battery_correlation_with": battery_corr,
    "compliance_correlation_with": compliance_corr,
    "nav_provider_summary": clean_records(nav_usage.to_dict(orient='records')),
    "os_summary": clean_records(os_usage.to_dict(orient='records')),
    "full_dimension_summary": clean_records(full_usage.to_dict(orient='records')),
    "charging_status_summary": clean_records(charging_usage.to_dict(orient='records')),
}

# ─── Chart Data ──────────────────────────────────────────────────────────────
chart_data = {}

chart_data['rides_by_nav_provider'] = {
    "labels": nav_usage['nav_provider'].tolist(),
    "values": nav_usage['total_rides'].tolist(),
    "nav_hours": clean_list(nav_usage['total_nav_hours'].tolist()),
    "battery_delta": clean_list(nav_usage['total_battery_delta'].tolist()),
    "drivers": nav_usage['total_drivers'].tolist(),
    "compliance_rate": [round(float(v), 4) if pd.notna(v) and not np.isinf(v) else None for v in nav_usage['avg_compliance_rate']],
}

chart_data['rides_by_os'] = {
    "labels": os_usage['os'].tolist(),
    "values": os_usage['total_rides'].tolist(),
    "nav_hours": clean_list(os_usage['total_nav_hours'].tolist()),
    "battery_delta": clean_list(os_usage['total_battery_delta'].tolist()),
    "drivers": os_usage['total_drivers'].tolist(),
    "compliance_rate": [round(float(v), 4) if pd.notna(v) and not np.isinf(v) else None for v in os_usage['avg_compliance_rate']],
}

chart_data['rides_by_os_infotainment'] = {
    "labels": full_usage['os_infotainment'].tolist(),
    "values": full_usage['total_rides'].tolist(),
    "nav_hours": clean_list(full_usage['total_nav_hours'].tolist()),
    "battery_delta": clean_list(full_usage['total_battery_delta'].tolist()),
    "compliance_rate": [round(float(v), 4) if pd.notna(v) and not np.isinf(v) else None for v in full_usage['avg_compliance_rate']],
    "battery_per_hour": [round(float(v), 4) if pd.notna(v) and not np.isinf(v) else None for v in full_usage['avg_battery_per_hour']],
}

chart_data['charging_status_breakdown'] = {
    "labels": charging_usage['charging_status'].tolist(),
    "total_rides": charging_usage['total_rides'].tolist(),
    "total_battery_delta": clean_list(charging_usage['total_battery_delta'].tolist()),
    "total_nav_hours": clean_list(charging_usage['total_nav_hours'].tolist()),
    "avg_compliance_rate": [round(float(v), 4) if pd.notna(v) and not np.isinf(v) else None for v in charging_usage['avg_compliance_rate']],
}

monthly_pivot_rides = monthly_nav.pivot(index='year_month', columns='nav_provider', values='total_rides').fillna(0)
monthly_pivot_battery = monthly_nav.pivot(index='year_month', columns='nav_provider', values='total_battery_delta').fillna(0)
monthly_pivot_compliance = monthly_nav.pivot(index='year_month', columns='nav_provider', values='avg_compliance_rate')

chart_data['monthly_rides_by_nav_provider'] = {
    "months": monthly_pivot_rides.index.tolist(),
    "series": {col: clean_list(monthly_pivot_rides[col].tolist()) for col in monthly_pivot_rides.columns}
}
chart_data['monthly_battery_by_nav_provider'] = {
    "months": monthly_pivot_battery.index.tolist(),
    "series": {col: clean_list(monthly_pivot_battery[col].tolist()) for col in monthly_pivot_battery.columns}
}
chart_data['monthly_compliance_by_nav_provider'] = {
    "months": monthly_pivot_compliance.index.tolist(),
    "series": {col: [round(float(v), 4) if pd.notna(v) and not np.isinf(v) else None for v in monthly_pivot_compliance[col]] for col in monthly_pivot_compliance.columns}
}

scatter_records = scatter_df.rename(columns={
    'nav_hours': 'x',
    'battery_delta': 'y',
    'nav_provider': 'group',
    'compliance_rate': 'compliance_rate',
    'n_rides_lyftnav': 'size'
}).to_dict(orient='records')
chart_data['scatter_battery_vs_nav_hours'] = clean_records(scatter_records)

corr_z = corr_matrix.values.tolist()
corr_z_clean = [[None if (isinstance(v, float) and (np.isnan(v) or np.isinf(v))) else round(float(v), 4) for v in row] for row in corr_z]
chart_data['correlation_heatmap'] = {
    "z": corr_z_clean,
    "x_labels": corr_labels,
    "y_labels": corr_labels
}

box_records = box_df[['nav_provider', 'battery_per_nav_hour']].rename(
    columns={'nav_provider': 'group', 'battery_per_nav_hour': 'value'}
).to_dict(orient='records')
chart_data['battery_per_hour_by_nav_provider'] = clean_records(box_records)

compliance_box_records = box_df[['nav_provider', 'compliance_rate']].rename(
    columns={'nav_provider': 'group', 'compliance_rate': 'value'}
).to_dict(orient='records')
chart_data['compliance_by_nav_provider'] = clean_records(compliance_box_records)

compliance_charging_box = df.dropna(subset=['charging_status', 'compliance_rate'])[['charging_status', 'compliance_rate']].rename(
    columns={'charging_status': 'group', 'compliance_rate': 'value'}
)
chart_data['compliance_by_charging_status'] = clean_records(compliance_charging_box.to_dict(orient='records'))

chart_data['rides_share_by_nav_provider'] = {
    "labels": nav_usage['nav_provider'].tolist(),
    "values": nav_usage['total_rides'].tolist()
}

chart_data['nav_hours_share_by_nav_provider'] = {
    "labels": nav_usage['nav_provider'].tolist(),
    "values": clean_list([round(float(v), 2) for v in nav_usage['total_nav_hours']])
}

# ─── Datasets ────────────────────────────────────────────────────────────────
df_out = df.copy()
df_out['date'] = df_out['date'].astype(str)
for col in ['compliance_rate', 'battery_per_nav_hour', 'battery_per_ride']:
    df_out[col] = df_out[col].round(4)

main_records = clean_records(df_out.head(5000).to_dict(orient='records'))

output = {
    "results": results,
    "chart_data": chart_data,
    "images": {},
    "datasets": {
        "main": main_records
    }
}

json.dump(output, open("/data/output.json", "w"), default=str, allow_nan=False)