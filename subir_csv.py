"""
Bulk uploader for historical Mercadona CSV snapshots into Supabase.

It discovers every file named ``Precios MERCADONA DD-MM-YYYY.csv`` in the
repository root, parses the snapshot date from the filename, and upserts:

- productos
- historial_precios
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

try:
    from supabase import create_client
except ImportError:
    print("ERROR: instala la dependencia 'supabase' con pip install -r requirements.txt")
    sys.exit(1)


CSV_NAME_RE = re.compile(r"^Precios MERCADONA (\d{2})-(\d{2})-(\d{4})\.csv$")
BATCH_SIZE = 500


def load_environment() -> None:
    if load_dotenv:
        load_dotenv()


def clean_text(value) -> str:
    return str(value or "").strip()


def parse_int(value):
    text = clean_text(value)
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def parse_float(value):
    text = clean_text(value).replace(",", ".")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_bool(value) -> bool:
    return clean_text(value).lower() in {"true", "1", "yes", "y", "si", "s"}


def parse_iso_date_from_filename(filename: str):
    match = CSV_NAME_RE.match(filename)
    if not match:
        return None
    day, month, year = match.groups()
    return f"{year}-{month}-{day}"


def discover_csv_files(base_dir: Path, from_date=None, to_date=None, limit=None):
    snapshots = []

    for path in base_dir.iterdir():
        if not path.is_file():
            continue
        iso_date = parse_iso_date_from_filename(path.name)
        if not iso_date:
            continue
        if from_date and iso_date < from_date:
            continue
        if to_date and iso_date > to_date:
            continue
        snapshots.append(
            {
                "filename": path.name,
                "filepath": path,
                "date": iso_date,
            }
        )

    snapshots.sort(key=lambda item: item["date"])
    if limit is not None:
        snapshots = snapshots[:limit]

    return snapshots


def parse_csv(filepath: Path):
    products = []

    with filepath.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")

        for row_number, row in enumerate(reader, start=2):
            product_id = parse_int(row.get("ID"))
            if product_id is None:
                print(f"  - fila {row_number}: ID invalido, se omite")
                continue

            price = parse_float(row.get("Precio"))
            if price is None:
                print(f"  - fila {row_number}: precio invalido para ID {product_id}, se omite")
                continue

            products.append(
                {
                    "id": product_id,
                    "nombre": clean_text(row.get("Nombre")),
                    "formato": clean_text(row.get("Formato")),
                    "precio": price,
                    "precio_referencia": parse_float(row.get("Precio Referencia")),
                    "url": clean_text(row.get("URL Producto")),
                    "imagen_url": clean_text(row.get("Imagen")),
                    "es_pesado": parse_bool(row.get("Pesado")),
                }
            )

    return products


def merge_product(existing, incoming):
    if existing is None:
        return dict(incoming)

    merged = dict(existing)
    for field in ("nombre", "formato", "url", "imagen_url"):
        if clean_text(incoming.get(field)):
            merged[field] = incoming[field]

    merged["es_pesado"] = bool(existing.get("es_pesado") or incoming.get("es_pesado"))
    return merged


def build_product_rows(snapshots):
    all_products = {}

    for snapshot in snapshots:
        for product in snapshot["products"]:
            all_products[product["id"]] = merge_product(all_products.get(product["id"]), product)

    return list(all_products.values())


def init_supabase():
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY")

    if not supabase_url or not supabase_key:
        raise RuntimeError("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el entorno.")

    return create_client(supabase_url, supabase_key)


def upload_products(supabase, products):
    print(f"\nSubiendo {len(products)} productos unicos...")

    rows = [
        {
            "id": product["id"],
            "nombre": product["nombre"],
            "formato": product["formato"],
            "url": product["url"],
            "imagen_url": product["imagen_url"],
            "es_pesado": product["es_pesado"],
        }
        for product in products
    ]

    for start in range(0, len(rows), BATCH_SIZE):
        batch = rows[start:start + BATCH_SIZE]
        supabase.table("productos").upsert(batch, on_conflict="id").execute()
        end = start + len(batch)
        print(f"  - productos {start + 1}-{end} de {len(rows)}")


def upload_prices(supabase, snapshot):
    rows = [
        {
            "producto_id": product["id"],
            "precio": product["precio"],
            "precio_referencia": product["precio_referencia"],
            "fecha": snapshot["date"],
        }
        for product in snapshot["products"]
    ]

    print(f"\nSubiendo {len(rows)} precios para {snapshot['date']} ({snapshot['filename']})...")

    for start in range(0, len(rows), BATCH_SIZE):
        batch = rows[start:start + BATCH_SIZE]
        supabase.table("historial_precios").upsert(
            batch,
            on_conflict="producto_id,fecha",
        ).execute()
        end = start + len(batch)
        print(f"  - precios {start + 1}-{end} de {len(rows)}")


def load_snapshots(base_dir: Path, from_date=None, to_date=None, limit=None):
    discovered = discover_csv_files(base_dir, from_date=from_date, to_date=to_date, limit=limit)

    if not discovered:
        raise RuntimeError("No se ha encontrado ningun CSV con el patron esperado.")

    snapshots = []
    for item in discovered:
        print(f"\nLeyendo {item['filename']}...")
        products = parse_csv(item["filepath"])
        print(f"  - {len(products)} productos leidos")
        snapshots.append(
            {
                **item,
                "products": products,
            }
        )

    return snapshots


def print_summary(snapshots, product_rows):
    print("\nResumen de backfill")
    print("-" * 50)
    print(f"Snapshots detectados: {len(snapshots)}")
    print(f"Productos unicos:     {len(product_rows)}")
    print(f"Primer snapshot:      {snapshots[0]['date']}")
    print(f"Ultimo snapshot:      {snapshots[-1]['date']}")
    print("Fechas:")
    for snapshot in snapshots:
        print(f"  - {snapshot['date']}: {len(snapshot['products'])} productos")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Sube todos los CSV historicos de Mercadona a Supabase."
    )
    parser.add_argument("--from-date", help="Fecha minima en formato YYYY-MM-DD.")
    parser.add_argument("--to-date", help="Fecha maxima en formato YYYY-MM-DD.")
    parser.add_argument("--limit", type=int, help="Limita el numero de snapshots a procesar.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Solo analiza y resume los CSV sin subir nada a Supabase.",
    )
    return parser.parse_args()


def main():
    load_environment()
    args = parse_args()
    base_dir = Path(__file__).resolve().parent

    print("=" * 50)
    print("BACKFILL CSV -> SUPABASE")
    print("=" * 50)

    snapshots = load_snapshots(
        base_dir,
        from_date=args.from_date,
        to_date=args.to_date,
        limit=args.limit,
    )
    product_rows = build_product_rows(snapshots)
    print_summary(snapshots, product_rows)

    if args.dry_run:
        print("\nModo dry-run: no se han subido datos.")
        return

    supabase = init_supabase()
    upload_products(supabase, product_rows)

    for snapshot in snapshots:
        upload_prices(supabase, snapshot)

    print("\nCarga completada correctamente.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"\nERROR: {error}")
        sys.exit(1)
