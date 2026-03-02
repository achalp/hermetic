import pandas as pd
import numpy as np
import json
import matplotlib.pyplot as plt
import seaborn as sns
from scipy import stats
import base64
from io import BytesIO

df = pd.read_csv("/data/input.csv")

df['ds'] = pd.to_datetime(df['ds'])
df['is_last_ds'] = df['is_last_ds'].astype(str).str.lower() == 'true'

numeric_cols = ['rides_lyftmaps', 'pct_lyftmaps_r7', 'pct_waze_r7', 'pct_google_inapp_r7', 
                'pct_gmaps_r7', 'r7_median_abs_reroute_cost_per_ride', 
                'r7_abs_reroute_cost_per_ride', 'r7_compliance']
for col in numeric_cols:
    df[col] = pd.to_numeric(df[col], errors='coerce')

results = {}

results['total_rows'] = int(len(df))
results['date_range'] = {
    'start': df['ds'].min().strftime('%Y-%m-%d'),
    'end': df['ds'].max().strftime('%Y-%m-%d'),
    'days': int((df['ds'].max() - df['ds'].min()).days + 1)
}
results['unique_regions'] = int(df['region'].nunique())
results['unique_states'] = int(df['state'].nunique())

latest_data = df[df['is_last_ds'] == True].copy()

results['latest_date_stats'] = {
    'date': latest_data['ds'].iloc[0].strftime('%Y-%m-%d') if len(latest_data) > 0 else None,
    'total_rides': int(latest_data['rides_lyftmaps'].sum()) if len(latest_data) > 0 else 0,
    'regions_reporting': int(len(latest_data))
}

overall_stats = {
    'avg_lyftmaps_adoption': float(df['pct_lyftmaps_r7'].mean()),
    'avg_waze_usage': float(df['pct_waze_r7'].mean()),
    'avg_gmaps_usage': float(df['pct_gmaps_r7'].mean()),
    'avg_google_inapp_usage': float(df['pct_google_inapp_r7'].mean()),
    'avg_compliance': float(df['r7_compliance'].mean()),
    'avg_reroute_cost': float(df['r7_abs_reroute_cost_per_ride'].mean()),
    'median_reroute_cost': float(df['r7_median_abs_reroute_cost_per_ride'].mean())
}
results['overall_stats'] = overall_stats

top_regions_rides = latest_data.nlargest(10, 'rides_lyftmaps')[['region', 'state', 'rides_lyftmaps', 'r7_compliance']].copy()
results['top_regions_by_rides'] = top_regions_rides.to_dict(orient='records')

top_regions_compliance = latest_data.nlargest(10, 'r7_compliance')[['region', 'state', 'r7_compliance', 'rides_lyftmaps']].copy()
results['top_regions_by_compliance'] = top_regions_compliance.to_dict(orient='records')

bottom_regions_compliance = latest_data.nsmallest(10, 'r7_compliance')[['region', 'state', 'r7_compliance', 'rides_lyftmaps']].copy()
results['bottom_regions_by_compliance'] = bottom_regions_compliance.to_dict(orient='records')

state_summary = latest_data.groupby('state').agg({
    'rides_lyftmaps': 'sum',
    'r7_compliance': 'mean',
    'pct_lyftmaps_r7': 'mean',
    'r7_abs_reroute_cost_per_ride': 'mean'
}).reset_index()
state_summary.columns = ['state', 'total_rides', 'avg_compliance', 'avg_lyftmaps_pct', 'avg_reroute_cost']
state_summary = state_summary.sort_values('total_rides', ascending=False)
results['state_summary'] = state_summary.head(15).to_dict(orient='records')

time_series = df.groupby('ds').agg({
    'rides_lyftmaps': 'sum',
    'r7_compliance': 'mean',
    'pct_lyftmaps_r7': 'mean',
    'r7_abs_reroute_cost_per_ride': 'mean'
}).reset_index().sort_values('ds')
time_series['ds'] = time_series['ds'].dt.strftime('%Y-%m-%d')
results['time_series_summary'] = time_series.to_dict(orient='records')

nav_app_usage = {
    'lyftmaps': float(df['pct_lyftmaps_r7'].mean() * 100),
    'waze': float(df['pct_waze_r7'].mean() * 100),
    'google_maps': float(df['pct_gmaps_r7'].mean() * 100),
    'google_inapp': float(df['pct_google_inapp_r7'].mean() * 100)
}
results['navigation_app_usage_pct'] = nav_app_usage

correlation_metrics = df[['rides_lyftmaps', 'pct_lyftmaps_r7', 'r7_compliance', 
                           'r7_abs_reroute_cost_per_ride', 'pct_waze_r7', 'pct_gmaps_r7']].corr()

results['key_correlations'] = {
    'compliance_vs_lyftmaps_adoption': float(correlation_metrics.loc['r7_compliance', 'pct_lyftmaps_r7']),
    'compliance_vs_reroute_cost': float(correlation_metrics.loc['r7_compliance', 'r7_abs_reroute_cost_per_ride']),
    'rides_vs_compliance': float(correlation_metrics.loc['rides_lyftmaps', 'r7_compliance'])
}

chart_data = {}

chart_data['rides_over_time'] = time_series[['ds', 'rides_lyftmaps']].rename(
    columns={'ds': 'date', 'rides_lyftmaps': 'rides'}
).to_dict(orient='records')

chart_data['compliance_over_time'] = time_series[['ds', 'r7_compliance']].rename(
    columns={'ds': 'date', 'r7_compliance': 'compliance'}
).to_dict(orient='records')

chart_data['top_regions_rides'] = latest_data.nlargest(15, 'rides_lyftmaps')[['region', 'rides_lyftmaps']].rename(
    columns={'rides_lyftmaps': 'rides'}
).to_dict(orient='records')

chart_data['top_states_rides'] = state_summary.head(10)[['state', 'total_rides']].rename(
    columns={'total_rides': 'rides'}
).to_dict(orient='records')

nav_app_data = [
    {'app': 'LyftMaps', 'percentage': nav_app_usage['lyftmaps']},
    {'app': 'Waze', 'percentage': nav_app_usage['waze']},
    {'app': 'Google Maps', 'percentage': nav_app_usage['google_maps']},
    {'app': 'Google In-App', 'percentage': nav_app_usage['google_inapp']}
]
chart_data['navigation_app_distribution'] = nav_app_data

chart_data['compliance_vs_lyftmaps'] = latest_data[['pct_lyftmaps_r7', 'r7_compliance', 'region']].rename(
    columns={'pct_lyftmaps_r7': 'lyftmaps_pct', 'r7_compliance': 'compliance'}
).to_dict(orient='records')

chart_data['reroute_cost_over_time'] = time_series[['ds', 'r7_abs_reroute_cost_per_ride']].rename(
    columns={'ds': 'date', 'r7_abs_reroute_cost_per_ride': 'cost'}
).to_dict(orient='records')

images = {}

fig, ax = plt.subplots(figsize=(10, 8))
sns.heatmap(correlation_metrics, annot=True, fmt='.3f', cmap='coolwarm', center=0, 
            square=True, linewidths=1, cbar_kws={"shrink": 0.8}, ax=ax)
ax.set_title('Correlation Matrix of Key Metrics', fontsize=14, fontweight='bold')
plt.tight_layout()
buf = BytesIO()
plt.savefig(buf, format='png', dpi=100, bbox_inches='tight')
buf.seek(0)
images['correlation_heatmap'] = base64.b64encode(buf.read()).decode('utf-8')
plt.close()

fig, axes = plt.subplots(2, 2, figsize=(14, 10))

axes[0, 0].hist(df['r7_compliance'].dropna(), bins=50, color='skyblue', edgecolor='black', alpha=0.7)
axes[0, 0].set_title('Distribution of Compliance Rates', fontweight='bold')
axes[0, 0].set_xlabel('Compliance Rate')
axes[0, 0].set_ylabel('Frequency')
axes[0, 0].axvline(df['r7_compliance'].mean(), color='red', linestyle='--', label=f'Mean: {df["r7_compliance"].mean():.3f}')
axes[0, 0].legend()

axes[0, 1].hist(df['pct_lyftmaps_r7'].dropna(), bins=50, color='lightgreen', edgecolor='black', alpha=0.7)
axes[0, 1].set_title('Distribution of LyftMaps Adoption', fontweight='bold')
axes[0, 1].set_xlabel('LyftMaps Percentage')
axes[0, 1].set_ylabel('Frequency')
axes[0, 1].axvline(df['pct_lyftmaps_r7'].mean(), color='red', linestyle='--', label=f'Mean: {df["pct_lyftmaps_r7"].mean():.3f}')
axes[0, 1].legend()

axes[1, 0].hist(df['r7_abs_reroute_cost_per_ride'].dropna(), bins=50, color='salmon', edgecolor='black', alpha=0.7)
axes[1, 0].set_title('Distribution of Reroute Cost per Ride', fontweight='bold')
axes[1, 0].set_xlabel('Reroute Cost')
axes[1, 0].set_ylabel('Frequency')
axes[1, 0].axvline(df['r7_abs_reroute_cost_per_ride'].mean(), color='red', linestyle='--', label=f'Mean: {df["r7_abs_reroute_cost_per_ride"].mean():.3f}')
axes[1, 0].legend()

axes[1, 1].hist(np.log10(df['rides_lyftmaps'].dropna() + 1), bins=50, color='plum', edgecolor='black', alpha=0.7)
axes[1, 1].set_title('Distribution of Rides (Log Scale)', fontweight='bold')
axes[1, 1].set_xlabel('Log10(Rides + 1)')
axes[1, 1].set_ylabel('Frequency')

plt.tight_layout()
buf = BytesIO()
plt.savefig(buf, format='png', dpi=100, bbox_inches='tight')
buf.seek(0)
images['distributions'] = base64.b64encode(buf.read()).decode('utf-8')
plt.close()

datasets = {}
df_output = df.copy()
df_output['ds'] = df_output['ds'].dt.strftime('%Y-%m-%d')
df_output = df_output.fillna('')
datasets['main'] = df_output.head(5000).to_dict(orient='records')

output = {
    'results': results,
    'chart_data': chart_data,
    'images': images,
    'datasets': datasets
}

with open('/data/output.json', 'w') as f:
    json.dump(output, f, default=str, allow_nan=False)