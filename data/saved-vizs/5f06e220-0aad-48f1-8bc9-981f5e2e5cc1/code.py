import pandas as pd
import numpy as np
from scipy import stats
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error
import json

# Read data
df = pd.read_csv("/data/input.csv")

# Clean data
df = df.dropna(subset=['fare_amount', 'tip_amount'])

# Correlation analysis
pearson_r, pearson_p = stats.pearsonr(df['fare_amount'], df['tip_amount'])
spearman_r, spearman_p = stats.spearmanr(df['fare_amount'], df['tip_amount'])

# Linear regression model
X = df['fare_amount'].values.reshape(-1, 1)
y = df['tip_amount'].values

model = LinearRegression()
model.fit(X, y)

y_pred = model.predict(X)
r2 = r2_score(y, y_pred)
rmse = np.sqrt(mean_squared_error(y, y_pred))

slope = float(model.coef_[0])
intercept = float(model.intercept_)

# Generate regression line points
fare_min = float(df['fare_amount'].min())
fare_max = float(df['fare_amount'].max())
fare_line = np.linspace(fare_min, fare_max, 100)
tip_line = slope * fare_line + intercept

# Scatter data for chart (actual points)
scatter_data = df[['fare_amount', 'tip_amount', 'payment_type', 'trip_distance']].copy()
scatter_data = scatter_data.fillna("")
scatter_records = scatter_data.to_dict(orient="records")

# Regression line data
regression_line = [
    {"fare_amount": round(float(f), 4), "predicted_tip": round(float(t), 4)}
    for f, t in zip(fare_line, tip_line)
]

# Stats by payment type
payment_stats = df.groupby('payment_type').agg(
    avg_fare=('fare_amount', 'mean'),
    avg_tip=('tip_amount', 'mean'),
    avg_distance=('trip_distance', 'mean'),
    count=('fare_amount', 'count'),
    tip_rate=('tip_amount', lambda x: (x > 0).mean() * 100)
).reset_index()
payment_stats = payment_stats.round(2)

# Fare buckets for aggregated view
df['fare_bucket'] = pd.cut(df['fare_amount'], bins=[0, 5, 10, 15, 20, 30, 70],
                            labels=['$0-5', '$5-10', '$10-15', '$15-20', '$20-30', '$30+'])
bucket_stats = df.groupby('fare_bucket', observed=True).agg(
    avg_tip=('tip_amount', 'mean'),
    count=('tip_amount', 'count')
).reset_index()
bucket_stats['fare_bucket'] = bucket_stats['fare_bucket'].astype(str)
bucket_stats = bucket_stats.round(2)

# Prediction examples
example_fares = [5, 10, 15, 20, 25, 30, 40, 50]
predictions = [
    {"fare": f, "predicted_tip": round(max(0, slope * f + intercept), 2)}
    for f in example_fares
]

# Residuals
df['predicted_tip'] = y_pred
df['residual'] = df['tip_amount'] - df['predicted_tip']

# Output
output = {
    "results": {
        "correlation": {
            "pearson_r": round(float(pearson_r), 4),
            "pearson_p_value": round(float(pearson_p), 6),
            "spearman_r": round(float(spearman_r), 4),
            "spearman_p_value": round(float(spearman_p), 6),
            "interpretation": "Strong positive correlation" if abs(pearson_r) > 0.7
                              else "Moderate positive correlation" if abs(pearson_r) > 0.4
                              else "Weak positive correlation"
        },
        "linear_model": {
            "equation": f"tip = {slope:.4f} × fare + {intercept:.4f}",
            "slope": round(slope, 4),
            "intercept": round(intercept, 4),
            "r_squared": round(r2, 4),
            "rmse": round(rmse, 4),
            "interpretation": f"For every $1 increase in fare, tip increases by ${slope:.2f}"
        },
        "data_summary": {
            "total_trips": int(len(df)),
            "avg_fare": round(float(df['fare_amount'].mean()), 2),
            "avg_tip": round(float(df['tip_amount'].mean()), 2),
            "trips_with_tip": int((df['tip_amount'] > 0).sum()),
            "tip_rate_pct": round(float((df['tip_amount'] > 0).mean() * 100), 1)
        },
        "payment_type_stats": payment_stats.to_dict(orient="records"),
        "fare_bucket_stats": bucket_stats.to_dict(orient="records"),
        "prediction_examples": predictions
    },
    "chart_data": {
        "scatter": scatter_records,
        "regression_line": regression_line,
        "payment_bar": payment_stats[['payment_type', 'avg_fare', 'avg_tip', 'count']].to_dict(orient="records"),
        "bucket_bar": bucket_stats.to_dict(orient="records")
    },
    "images": {},
    "datasets": {
        "main": df.drop(columns=['fare_bucket']).fillna("").head(5000).to_dict(orient="records")
    }
}

json.dump(output, open("/data/output.json", "w"), default=str, allow_nan=False)