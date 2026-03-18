import requests
import csv
import time
import json
import logging
import sys
import os
import argparse
from datetime import datetime
from dotenv import load_dotenv

# --- CARGAR VARIABLES DE ENTORNO ---
load_dotenv()

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_SERVICE_KEY = os.getenv('SUPABASE_SERVICE_KEY')

# --- CONFIGURACIÓN DEL LOGGING ---
# En CI (GitHub Actions), escribir logs en directorio de trabajo actual
LOG_FILENAME = f"mercadona_log_{datetime.now().strftime('%Y-%m-%d')}.log"
IS_CI = os.getenv('GITHUB_ACTIONS') == 'true'

logger = logging.getLogger()
logger.setLevel(logging.INFO)
formatter = logging.Formatter('%(asctime)s - [%(levelname)s] - %(message)s')

file_handler = logging.FileHandler(LOG_FILENAME, encoding='utf-8')
file_handler.setFormatter(formatter)
logger.addHandler(file_handler)

console_handler = logging.StreamHandler(sys.stdout)
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)
# -------------------------------------------

# Global Configuration
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
}

COOKIES = {
    '__mo_da': json.dumps({"warehouse": "mad1", "postalCode": "28001"}),
    '__mo_ui': json.dumps({"language": "es"}),
    '__mo_ca': '{"third_party":true}'
}

OUTPUT_FILE = f"Precios MERCADONA {datetime.now().strftime('%d-%m-%Y')}.csv"
ALL_PRODUCTS = []
ALL_CATEGORIES = {}  # id -> {nombre, parent_id}
DEBUG_FIRST_PRODUCT_DONE = False


def init_supabase():
    """Inicializa el cliente de Supabase si las credenciales están disponibles."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        logger.warning("Variables SUPABASE_URL o SUPABASE_SERVICE_KEY no configuradas.")
        logger.warning("Se guardará solo en CSV. Configura el .env para subir a Supabase.")
        return None
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        logger.info(f"✅ Conectado a Supabase: {SUPABASE_URL}")
        return client
    except ImportError:
        logger.error("Librería 'supabase' no instalada. Ejecuta: pip install supabase")
        return None
    except Exception as e:
        logger.error(f"Error conectando a Supabase: {e}")
        return None


def collect_categories(node, parent_id=None):
    """Recorre el árbol de categorías y las almacena."""
    try:
        cat_id = int(node.get('id'))
        cat_name = node.get('name', '')
        
        if cat_id and cat_name:
            ALL_CATEGORIES[cat_id] = {
                'id': cat_id,
                'nombre': cat_name,
                'parent_id': int(parent_id) if parent_id is not None else None
            }
        
        if 'categories' in node and node['categories']:
            for sub in node['categories']:
                collect_categories(sub, parent_id=cat_id)
    except (TypeError, ValueError):
        pass


def traverse_and_collect(node, category_id=None):
    global DEBUG_FIRST_PRODUCT_DONE
    
    # Detectar categoría actual
    current_cat_id = node.get('id', category_id)
    
    # Recolectar productos si existen en el nodo
    if 'products' in node and node['products']:
        for p in node['products']:
            try:
                # --- MODO DETECTIVE ---
                if not DEBUG_FIRST_PRODUCT_DONE:
                    logger.info("--- [DEBUG] ESTRUCTURA DE UN PRODUCTO ---")
                    logger.info(json.dumps(p, indent=2, ensure_ascii=False))
                    logger.info("--- [FIN DEBUG] ---")
                    DEBUG_FIRST_PRODUCT_DONE = True
                
                # --- DATOS BÁSICOS ---
                prod_id = p.get('id', '')
                prod_slug = p.get('slug', 'producto')
                
                # --- CONSTRUCCIÓN DE LA URL ---
                full_url = f"https://tienda.mercadona.es/product/{prod_id}/{prod_slug}"
                
                price_unit = p.get('price_instructions', {}).get('unit_price', '0.00')
                price_bulk = p.get('price_instructions', {}).get('bulk_price', '0.00')
                
                # --- CÁLCULO DE PESO ---
                explicit_size = p.get('format_size') or p.get('unit_size') or p.get('net_content')
                packaging = p.get('packaging', '')
                calculated_txt = ""
                try:
                    p_u = float(price_unit)
                    p_b = float(price_bulk)
                    if p_b > 0.001:
                        val = p_u / p_b
                        if abs(val - round(val)) < 0.03:
                            val_fmt = f"{int(round(val))}"
                        else:
                            val_fmt = f"{val:.2f}"
                        calculated_txt = val_fmt
                except Exception:
                    pass

                if explicit_size:
                    final_format = explicit_size
                elif calculated_txt:
                    if packaging:
                        final_format = f"{packaging} ({calculated_txt} eq)"
                    else:
                        final_format = f"{calculated_txt} eq"
                else:
                    final_format = packaging
                # ----------------------------------------

                # --- ID DE CATEGORÍA SANITIZAD0 ---
                try:
                    # Usar float primero por si viene como "123.0"
                    p_cat_id = int(float(current_cat_id)) if current_cat_id is not None else None
                except (ValueError, TypeError):
                    p_cat_id = None
                
                # Si tenemos un ID de categoría pero no está en nuestro diccionario,
                # lo añadimos como "Categoría Desconocida" para evitar FK Violations.
                if p_cat_id and p_cat_id not in ALL_CATEGORIES:
                    ALL_CATEGORIES[p_cat_id] = {
                        'id': p_cat_id,
                        'nombre': f'Categoría {p_cat_id}',
                        'parent_id': None
                    }

                product_info = {
                    'id': int(float(prod_id)),
                    'name': p.get('display_name', ''),
                    'pack_size': final_format,
                    'price': price_unit,
                    'price_bulk': price_bulk,
                    'url': full_url,
                    'image_url': p.get('thumbnail', ''),
                    'is_heavy': p.get('is_heavy_buy', False),
                    'category_id': p_cat_id
                }
                ALL_PRODUCTS.append(product_info)
            except Exception as e:
                logger.warning(f"Error parseando producto {node.get('id', '?')}: {e}")

    # Recursividad
    if 'categories' in node and node['categories']:
        for subresult in node['categories']:
            traverse_and_collect(subresult, category_id=current_cat_id)
    elif 'badged_categories' in node and node['badged_categories']:
        # Mercadona a veces usa 'badged_categories' para niveles profundos
        for subresult in node['badged_categories']:
            traverse_and_collect(subresult, category_id=current_cat_id)


def process_subcategory(category_data):
    cat_id = category_data['id']
    logger.info(f"  Fetching details for: {category_data['name']} (ID: {cat_id})")
    
    url_cat_detail = f"https://tienda.mercadona.es/api/categories/{cat_id}/?lang=es&wh=mad1"
    try:
        r = requests.get(url_cat_detail, headers=HEADERS, cookies=COOKIES)
        if r.status_code == 200:
            detail = r.json()
            traverse_and_collect(detail, category_id=cat_id)
        else:
            logger.warning(f"    Failed sub-category {cat_id}. Status: {r.status_code}")
            
    except Exception as e:
        logger.error(f"    ERROR processing sub-category {cat_id}: {e}", exc_info=True)
        
    time.sleep(0.5)


def upload_to_supabase(supabase_client):
    """Sube categorías, productos e historial de precios a Supabase."""
    if not supabase_client:
        return
    
    logger.info("=== SUBIENDO DATOS A SUPABASE ===")
    
    # 1. Upsert categorías (primero las que NO tienen parent, luego las hijas)
    if ALL_CATEGORIES:
        # Ordenar: primero raíces (parent_id=None), luego hijas
        roots = [c for c in ALL_CATEGORIES.values() if c['parent_id'] is None]
        children = [c for c in ALL_CATEGORIES.values() if c['parent_id'] is not None]
        ordered_cats = roots + children
        
        # Lotes de 500
        batch_size = 500
        for i in range(0, len(ordered_cats), batch_size):
            batch = ordered_cats[i:i + batch_size]
            try:
                supabase_client.table('categorias').upsert(
                    batch,
                    on_conflict='id'
                ).execute()
                logger.info(f"  ✅ Categorías: lote {i // batch_size + 1} ({len(batch)} categorías)")
            except Exception as e:
                logger.error(f"  ❌ Error subiendo categorías: {e}")
        
        logger.info(f"  Total categorías subidas: {len(ordered_cats)}")
    
    # 2. Upsert productos (deduplicados)
    seen_ids = set()
    unique_products = []
    for p in ALL_PRODUCTS:
        if p['id'] not in seen_ids:
            unique_products.append({
                'id': p['id'],
                'nombre': p['name'],
                'formato': p['pack_size'],
                'url': p['url'],
                'imagen_url': p['image_url'],
                'es_pesado': p['is_heavy'],
                'categoria_id': p['category_id']
            })
            seen_ids.add(p['id'])
    
    batch_size = 500
    for i in range(0, len(unique_products), batch_size):
        batch = unique_products[i:i + batch_size]
        try:
            supabase_client.table('productos').upsert(
                batch,
                on_conflict='id'
            ).execute()
            logger.info(f"  ✅ Productos: lote {i // batch_size + 1} ({len(batch)} productos)")
        except Exception as e:
            logger.error(f"  ❌ Error subiendo productos: {e}")
    
    logger.info(f"  Total productos subidos: {len(unique_products)}")
    
    # 3. Insertar historial de precios (un registro por producto por día)
    today = datetime.now().strftime('%Y-%m-%d')
    seen_ids_precios = set()
    precios_hoy = []
    
    for p in ALL_PRODUCTS:
        if p['id'] not in seen_ids_precios:
            try:
                precio = float(p['price']) if p['price'] else 0.0
                precio_ref = float(p['price_bulk']) if p['price_bulk'] else None
                precios_hoy.append({
                    'producto_id': p['id'],
                    'precio': precio,
                    'precio_referencia': precio_ref,
                    'fecha': today
                })
                seen_ids_precios.add(p['id'])
            except (ValueError, TypeError):
                pass
    
    for i in range(0, len(precios_hoy), batch_size):
        batch = precios_hoy[i:i + batch_size]
        try:
            supabase_client.table('historial_precios').upsert(
                batch,
                on_conflict='producto_id,fecha'
            ).execute()
            logger.info(f"  ✅ Precios: lote {i // batch_size + 1} ({len(batch)} registros)")
        except Exception as e:
            logger.error(f"  ❌ Error subiendo precios: {e}")
    
    logger.info(f"  Total registros de precios: {len(precios_hoy)}")
    logger.info("=== FIN SUBIDA A SUPABASE ===")


def save_csv():
    """Guarda los productos en CSV (backup)."""
    if not ALL_PRODUCTS:
        logger.warning("No products found to save.")
        return
    
    try:
        with open(OUTPUT_FILE, mode='w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f, delimiter=';')
            header = ['ID', 'Nombre', 'Formato', 'Precio', 'Precio Referencia', 'URL Producto', 'Imagen', 'Pesado']
            writer.writerow(header)
            
            seen_ids = set()
            count = 0
            for p in ALL_PRODUCTS:
                if p['id'] not in seen_ids:
                    writer.writerow([
                        p['id'],
                        p['name'],
                        p['pack_size'],
                        p['price'],
                        p['price_bulk'],
                        p['url'],
                        p['image_url'],
                        p['is_heavy']
                    ])
                    seen_ids.add(p['id'])
                    count += 1
        
        logger.info(f"Saved {count} products to {OUTPUT_FILE}")
    except Exception as e:
        logger.error(f"Error saving CSV: {e}", exc_info=True)


def fetch_mercadona_products():
    logger.info("=== INICIANDO SCRAPER MERCADONA ===")
    
    url_categories = "https://tienda.mercadona.es/api/categories/?lang=es&wh=mad1"
    
    try:
        response = requests.get(url_categories, headers=HEADERS, cookies=COOKIES, timeout=15)
        response.raise_for_status()
        data = response.json()
        categories = data.get('results', [])
        logger.info(f"Fetched {len(categories)} root categories.")
    except Exception as e:
        logger.critical(f"Failed initial fetch: {e}", exc_info=True)
        return

    # Recolectar árbol de categorías
    for cat in categories:
        collect_categories(cat)
        if 'categories' in cat:
            for sub in cat['categories']:
                collect_categories(sub, parent_id=cat['id'])
    
    logger.info(f"Categorías encontradas: {len(ALL_CATEGORIES)}")

    # Recolectar productos
    for cat in categories:
        logger.info(f"Root: {cat['name']}")
        if 'categories' in cat:
            for sub in cat['categories']:
                process_subcategory(sub)
        else:
            process_subcategory(cat)

    logger.info(f"Total products: {len(ALL_PRODUCTS)}")


def main():
    parser = argparse.ArgumentParser(description='Scraper de precios de Mercadona')
    parser.add_argument('--csv', action='store_true', help='Guardar también en CSV (además de Supabase)')
    parser.add_argument('--csv-only', action='store_true', help='Solo guardar en CSV, no subir a Supabase')
    args = parser.parse_args()
    
    # 1. Raspar productos
    fetch_mercadona_products()
    
    if not ALL_PRODUCTS:
        logger.warning("No se encontraron productos. Abortando.")
        return
    
    # 2. Subir a Supabase (a menos que sea --csv-only)
    if not args.csv_only:
        supabase_client = init_supabase()
        upload_to_supabase(supabase_client)
    
    # 3. Guardar CSV si se solicita
    if args.csv or args.csv_only:
        save_csv()
    
    logger.info("=== FIN DEL SCRAPER ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as main_e:
        logger.critical("Error no controlado en la ejecución principal:", exc_info=True)
