import pandas as pd
import numpy as np
import json
import matplotlib.pyplot as plt
import seaborn as sns
from io import BytesIO
import base64

df = pd.read_csv("/data/input.csv")

df_original = df.copy()

df = df.fillna("")

results = {}

results["total_locations"] = int(len(df))
results["categories"] = df["category"].value_counts().to_dict()
results["avg_revenue"] = float(df["revenue"].mean())
results["avg_rating"] = float(df["rating"].mean())
results["total_revenue"] = float(df["revenue"].sum())
results["avg_reviews"] = float(df["reviews"].mean())

category_stats = df.groupby("category").agg({
    "revenue": ["mean", "sum", "count"],
    "rating": "mean",
    "reviews": "mean"
}).round(2)
category_stats.columns = ["_".join(col).strip() for col in category_stats.columns.values]
results["category_stats"] = category_stats.to_dict()

top_revenue = df.nlargest(5, "revenue")[["name", "category", "revenue", "rating"]].to_dict(orient="records")
results["top_revenue_locations"] = top_revenue

top_rated = df.nlargest(5, "rating")[["name", "category", "rating", "reviews"]].to_dict(orient="records")
results["top_rated_locations"] = top_rated

df["years_operating"] = 2024 - df["year_opened"]
revenue_per_year = (df["revenue"] / df["years_operating"]).replace([np.inf, -np.inf], 0)
results["avg_revenue_per_year"] = float(revenue_per_year.mean())

correlation_matrix = df[["revenue", "rating", "reviews", "year_opened"]].corr()
results["correlations"] = correlation_matrix.to_dict()

chart_data = {}

category_revenue = df.groupby("category").agg({
    "revenue": "sum",
    "rating": "mean"
}).reset_index()
category_revenue["rating"] = category_revenue["rating"].round(2)
chart_data["category_revenue"] = category_revenue.to_dict(orient="records")

revenue_rating_scatter = df[["name", "revenue", "rating", "category", "reviews"]].copy()
revenue_rating_scatter = revenue_rating_scatter.to_dict(orient="records")
chart_data["revenue_rating_scatter"] = revenue_rating_scatter

year_data = df.groupby("year_opened").agg({
    "revenue": "mean",
    "id": "count"
}).reset_index()
year_data.columns = ["year_opened", "avg_revenue", "count"]
year_data = year_data.sort_values("year_opened")
year_data["avg_revenue"] = year_data["avg_revenue"].round(0)
chart_data["year_opened_trend"] = year_data.to_dict(orient="records")

map_data = df[["id", "name", "category", "latitude", "longitude", "revenue", "rating", "reviews"]].copy()
chart_data["map_locations"] = map_data.to_dict(orient="records")

revenue_bins = [0, 100000, 200000, 300000, 500000]
revenue_labels = ["0-100k", "100k-200k", "200k-300k", "300k+"]
df["revenue_bracket"] = pd.cut(df["revenue"], bins=revenue_bins, labels=revenue_labels, include_lowest=True)
revenue_distribution = df["revenue_bracket"].value_counts().reset_index()
revenue_distribution.columns = ["bracket", "count"]
revenue_distribution = revenue_distribution.sort_values("bracket")
chart_data["revenue_distribution"] = revenue_distribution.to_dict(orient="records")

category_counts = df["category"].value_counts().reset_index()
category_counts.columns = ["category", "count"]
chart_data["category_distribution"] = category_counts.to_dict(orient="records")

images = {}

fig, axes = plt.subplots(2, 2, figsize=(14, 12))

corr_data = df[["revenue", "rating", "reviews", "year_opened"]].corr()
sns.heatmap(corr_data, annot=True, fmt=".2f", cmap="coolwarm", center=0, ax=axes[0, 0], cbar_kws={"shrink": 0.8})
axes[0, 0].set_title("Correlation Matrix: Revenue, Rating, Reviews, Year Opened", fontsize=12, fontweight="bold")

category_order = df.groupby("category")["revenue"].sum().sort_values(ascending=False).index
sns.boxplot(data=df, x="category", y="revenue", order=category_order, ax=axes[0, 1], palette="Set2")
axes[0, 1].set_title("Revenue Distribution by Category", fontsize=12, fontweight="bold")
axes[0, 1].set_xlabel("Category")
axes[0, 1].set_ylabel("Revenue ($)")
axes[0, 1].tick_params(axis='x', rotation=45)

sns.histplot(df["rating"], bins=15, kde=True, ax=axes[1, 0], color="skyblue", edgecolor="black")
axes[1, 0].set_title("Rating Distribution with KDE", fontsize=12, fontweight="bold")
axes[1, 0].set_xlabel("Rating")
axes[1, 0].set_ylabel("Frequency")

sns.scatterplot(data=df, x="reviews", y="revenue", hue="category", size="rating", sizes=(50, 400), alpha=0.7, ax=axes[1, 1], palette="tab10")
axes[1, 1].set_title("Revenue vs Reviews by Category", fontsize=12, fontweight="bold")
axes[1, 1].set_xlabel("Number of Reviews")
axes[1, 1].set_ylabel("Revenue ($)")
axes[1, 1].legend(bbox_to_anchor=(1.05, 1), loc='upper left', fontsize=8)

plt.tight_layout()

buffer = BytesIO()
plt.savefig(buffer, format="png", dpi=100, bbox_inches="tight")
buffer.seek(0)
image_base64 = base64.b64encode(buffer.read()).decode()
plt.close()

images["analysis_dashboard"] = image_base64

datasets = {}
df_output = df_original.head(5000).fillna("")
datasets["main"] = df_output.to_dict(orient="records")

output = {
    "results": results,
    "chart_data": chart_data,
    "images": images,
    "datasets": datasets
}

with open("/data/output.json", "w") as f:
    json.dump(output, f, default=str, allow_nan=False)