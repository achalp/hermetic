import pandas as pd
import json

df = pd.read_csv("/data/input.csv")

df['origin_lat'] = pd.to_numeric(df['origin_lat'], errors='coerce')
df['origin_lng'] = pd.to_numeric(df['origin_lng'], errors='coerce')
df['dest_lat'] = pd.to_numeric(df['dest_lat'], errors='coerce')
df['dest_lng'] = pd.to_numeric(df['dest_lng'], errors='coerce')
df['passengers'] = pd.to_numeric(df['passengers'], errors='coerce')

df_clean = df.fillna("")

unique_origin_cities = sorted(df['origin_city'].dropna().unique().tolist())
unique_dest_cities = sorted(df['dest_city'].dropna().unique().tolist())
unique_airlines = sorted(df['airline'].dropna().unique().tolist())

origin_lat_range = {
    "min": float(df['origin_lat'].min()) if not df['origin_lat'].isna().all() else -90,
    "max": float(df['origin_lat'].max()) if not df['origin_lat'].isna().all() else 90
}
origin_lng_range = {
    "min": float(df['origin_lng'].min()) if not df['origin_lng'].isna().all() else -180,
    "max": float(df['origin_lng'].max()) if not df['origin_lng'].isna().all() else 180
}
dest_lat_range = {
    "min": float(df['dest_lat'].min()) if not df['dest_lat'].isna().all() else -90,
    "max": float(df['dest_lat'].max()) if not df['dest_lat'].isna().all() else 90
}
dest_lng_range = {
    "min": float(df['dest_lng'].min()) if not df['dest_lng'].isna().all() else -180,
    "max": float(df['dest_lng'].max()) if not df['dest_lng'].isna().all() else 180
}
passengers_range = {
    "min": int(df['passengers'].min()) if not df['passengers'].isna().all() else 0,
    "max": int(df['passengers'].max()) if not df['passengers'].isna().all() else 1000000
}

form_schema = {
    "fields": [
        {
            "name": "origin_city",
            "label": "Origin City",
            "type": "text",
            "required": True,
            "suggestions": unique_origin_cities
        },
        {
            "name": "origin_lat",
            "label": "Origin Latitude",
            "type": "number",
            "required": True,
            "min": origin_lat_range["min"],
            "max": origin_lat_range["max"],
            "step": 0.0001
        },
        {
            "name": "origin_lng",
            "label": "Origin Longitude",
            "type": "number",
            "required": True,
            "min": origin_lng_range["min"],
            "max": origin_lng_range["max"],
            "step": 0.0001
        },
        {
            "name": "dest_city",
            "label": "Destination City",
            "type": "text",
            "required": True,
            "suggestions": unique_dest_cities
        },
        {
            "name": "dest_lat",
            "label": "Destination Latitude",
            "type": "number",
            "required": True,
            "min": dest_lat_range["min"],
            "max": dest_lat_range["max"],
            "step": 0.0001
        },
        {
            "name": "dest_lng",
            "label": "Destination Longitude",
            "type": "number",
            "required": True,
            "min": dest_lng_range["min"],
            "max": dest_lng_range["max"],
            "step": 0.0001
        },
        {
            "name": "passengers",
            "label": "Passengers",
            "type": "number",
            "required": True,
            "min": 0,
            "max": passengers_range["max"],
            "step": 1000
        },
        {
            "name": "airline",
            "label": "Airline",
            "type": "text",
            "required": True,
            "suggestions": unique_airlines
        }
    ]
}

output = {
    "results": {
        "total_rows": len(df),
        "columns": list(df.columns),
        "form_description": "Form to enter a new flight route record with origin, destination, passengers, and airline information"
    },
    "chart_data": {
        "form_schema": form_schema
    },
    "datasets": {
        "main": df_clean.head(5000).to_dict(orient="records")
    }
}

with open("/data/output.json", "w") as f:
    json.dump(output, f, default=str, allow_nan=False)