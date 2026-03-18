"""
Script para subir los CSV existentes a Supabase.
Lee los archivos CSV y los sube como productos + historial de precios.
"""
import csv
import os
import sys
from datetime import datetime

# Intentar importar supabase
try:
    from supabase import create_client
except ImportError:
    print("ERROR: Instala supabase-py primero: pip install supabase")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    print("AVISO: python-dotenv no instalado, usando variables de entorno directas")

# Config
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Configura SUPABASE_URL y SUPABASE_SERVICE_KEY en .env")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# CSVs a procesar: {archivo: fecha}
CSV_FILES = {
    "Precios MERCADONA 27-01-2026.csv": "2026-01-27",
    "Precios MERCADONA 08-03-2026.csv": "2026-03-08",
}

BATCH_SIZE = 500

def parse_csv(filepath):
    """Lee un CSV y devuelve lista de dicts."""
    productos = []
    with open(filepath, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            try:
                productos.append({
                    "id": int(row["ID"]),
                    "nombre": row["Nombre"].strip(),
                    "formato": row["Formato"].strip(),
                    "precio": float(row["Precio"]),
                    "precio_referencia": float(row["Precio Referencia"]),
                    "url": row["URL Producto"].strip(),
                    "imagen_url": row["Imagen"].strip(),
                    "es_pesado": row["Pesado"].strip().lower() == "true",
                })
            except (ValueError, KeyError) as e:
                print(f"  ⚠ Saltando fila con error: {e}")
    return productos


def upload_products(productos):
    """Sube productos a la tabla 'productos' con upsert."""
    print(f"\n📦 Subiendo {len(productos)} productos...")
    
    product_rows = []
    seen_ids = set()
    for p in productos:
        if p["id"] in seen_ids:
            continue
        seen_ids.add(p["id"])
        product_rows.append({
            "id": p["id"],
            "nombre": p["nombre"],
            "formato": p["formato"],
            "url": p["url"],
            "imagen_url": p["imagen_url"],
            "es_pesado": p["es_pesado"],
        })
    
    total = len(product_rows)
    for i in range(0, total, BATCH_SIZE):
        batch = product_rows[i:i + BATCH_SIZE]
        try:
            supabase.table("productos").upsert(batch, on_conflict="id").execute()
            print(f"  ✓ Productos {i+1}-{min(i+BATCH_SIZE, total)} de {total}")
        except Exception as e:
            print(f"  ✗ Error en lote {i//BATCH_SIZE + 1}: {e}")
    
    print(f"  ✅ {total} productos únicos subidos")


def upload_prices(productos, fecha):
    """Sube precios al historial."""
    print(f"\n💰 Subiendo precios para fecha {fecha}...")
    
    price_rows = []
    for p in productos:
        price_rows.append({
            "producto_id": p["id"],
            "precio": p["precio"],
            "precio_referencia": p["precio_referencia"],
            "fecha": fecha,
        })
    
    total = len(price_rows)
    for i in range(0, total, BATCH_SIZE):
        batch = price_rows[i:i + BATCH_SIZE]
        try:
            supabase.table("historial_precios").upsert(
                batch, on_conflict="producto_id,fecha"
            ).execute()
            print(f"  ✓ Precios {i+1}-{min(i+BATCH_SIZE, total)} de {total}")
        except Exception as e:
            print(f"  ✗ Error en lote {i//BATCH_SIZE + 1}: {e}")
    
    print(f"  ✅ {total} registros de precio subidos para {fecha}")


def main():
    print("=" * 50)
    print("📊 SUBIDA DE CSV A SUPABASE")
    print("=" * 50)
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    all_products = {}  # id -> product data (último CSV gana)
    
    for filename, fecha in CSV_FILES.items():
        filepath = os.path.join(base_dir, filename)
        if not os.path.exists(filepath):
            print(f"\n⚠ No se encuentra: {filename}")
            continue
        
        print(f"\n📄 Leyendo {filename}...")
        productos = parse_csv(filepath)
        print(f"   {len(productos)} productos leídos")
        
        # Subir precios de este CSV con su fecha
        upload_prices(productos, fecha)
        
        # Guardar productos para upsert final
        for p in productos:
            all_products[p["id"]] = p
    
    # Subir todos los productos únicos (upsert)
    if all_products:
        upload_products(list(all_products.values()))
    
    print("\n" + "=" * 50)
    print("🎉 ¡COMPLETADO!")
    print("=" * 50)


if __name__ == "__main__":
    main()
