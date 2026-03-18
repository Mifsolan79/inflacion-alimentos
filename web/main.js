// =========================================
// INFLACIÓN TRACK — MAIN APPLICATION
// =========================================

import './style.css';
import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';

// --- SUPABASE CONFIG ---
const SUPABASE_URL = 'https://qvgxqiqxapnckenmqbwf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2Z3hxaXF4YXBuY2tlbm1xYndmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3NjU4NDYsImV4cCI6MjA4OTM0MTg0Nn0.jr-u1sw0AoOyweJkOAn7w53SOH8OFnqBtzzdH3VeK8s';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- STATE ---
let allProducts = [];
let allCategories = [];
let chartInstances = {};
let searchTimeout = null;

// --- INIT ---
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupModal();
  setupGlobalSearch();
  await loadData();
});

// =========================================
// NAVIGATION
// =========================================
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const viewId = item.dataset.view;
      
      // Update nav active state
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      
      // Show correct view
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const targetView = document.getElementById(`view-${viewId}`);
      if (targetView) targetView.classList.add('active');
    });
  });
}

// =========================================
// DATA LOADING
// =========================================
async function loadData() {
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');
  
  try {
    // Load categories
    const { data: cats, error: catErr } = await supabase
      .from('categorias')
      .select('*')
      .order('nombre');
    
    if (catErr) throw catErr;
    allCategories = cats || [];

    // Load products with latest prices
    const { data: products, error: prodErr } = await supabase
      .from('productos')
      .select(`
        *,
        historial_precios (
          precio,
          precio_referencia,
          fecha
        )
      `)
      .order('nombre');
    
    if (prodErr) throw prodErr;
    allProducts = (products || []).map(p => ({
      ...p,
      latestPrice: getLatestPrice(p.historial_precios),
      priceHistory: (p.historial_precios || []).sort((a, b) => 
        new Date(a.fecha) - new Date(b.fecha)
      )
    }));
    
    // Update status
    statusDot.classList.add('connected');
    statusText.textContent = `${allProducts.length} productos`;
    
    // Update last update
    const dates = allProducts.flatMap(p => p.priceHistory.map(h => h.fecha));
    const latestDate = dates.length > 0 ? dates.sort().reverse()[0] : null;
    if (latestDate) {
      document.getElementById('lastUpdate').textContent = 
        `Última actualización: ${formatDate(latestDate)}`;
    }
    
    // Render all views
    renderDashboard();
    renderCategories();
    setupSearchPage();
    renderTrends();

  } catch (err) {
    console.error('Error loading data:', err);
    statusDot.classList.add('error');
    statusText.textContent = 'Error de conexión';
  }
}

function getLatestPrice(history) {
  if (!history || history.length === 0) return null;
  const sorted = [...history].sort((a, b) => 
    new Date(b.fecha) - new Date(a.fecha)
  );
  return sorted[0];
}

// =========================================
// DASHBOARD VIEW
// =========================================
function renderDashboard() {
  // Stats
  document.getElementById('totalProducts').textContent = allProducts.length.toLocaleString('es-ES');
  document.getElementById('totalCategories').textContent = allCategories.length.toLocaleString('es-ES');
  
  // Calculate price changes
  const changes = calculatePriceChanges();
  document.getElementById('priceUp').textContent = changes.up.length.toLocaleString('es-ES');
  document.getElementById('priceDown').textContent = changes.down.length.toLocaleString('es-ES');
  
  // Top Up Chart
  renderBarChart('chartTopUp', 
    changes.up.slice(0, 10).map(c => truncate(c.nombre, 25)),
    changes.up.slice(0, 10).map(c => c.changePercent),
    'rgba(239, 68, 68, 0.8)', 'rgba(239, 68, 68, 0.2)'
  );
  
  // Top Down Chart
  renderBarChart('chartTopDown',
    changes.down.slice(0, 10).map(c => truncate(c.nombre, 25)),
    changes.down.slice(0, 10).map(c => c.changePercent),
    'rgba(34, 197, 94, 0.8)', 'rgba(34, 197, 94, 0.2)'
  );
  
  // Recent products
  const recent = [...allProducts]
    .filter(p => p.latestPrice)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 12);
  
  renderProductGrid('recentProducts', recent);
}

function calculatePriceChanges() {
  const up = [];
  const down = [];
  
  for (const p of allProducts) {
    if (p.priceHistory.length < 2) continue;
    
    const sorted = [...p.priceHistory].sort((a, b) => 
      new Date(a.fecha) - new Date(b.fecha)
    );
    
    const first = sorted[0].precio;
    const last = sorted[sorted.length - 1].precio;
    
    if (first === 0) continue;
    
    const changePercent = ((last - first) / first * 100);
    
    if (changePercent > 0.01) {
      up.push({ ...p, changePercent: +changePercent.toFixed(2) });
    } else if (changePercent < -0.01) {
      down.push({ ...p, changePercent: +changePercent.toFixed(2) });
    }
  }
  
  up.sort((a, b) => b.changePercent - a.changePercent);
  down.sort((a, b) => a.changePercent - b.changePercent);
  
  return { up, down };
}

// =========================================
// SEARCH
// =========================================
function setupGlobalSearch() {
  const input = document.getElementById('globalSearch');
  const dropdown = document.getElementById('searchDropdown');
  
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = input.value.trim().toLowerCase();
    
    if (query.length < 2) {
      dropdown.classList.add('hidden');
      return;
    }
    
    searchTimeout = setTimeout(() => {
      const results = allProducts
        .filter(p => p.nombre.toLowerCase().includes(query))
        .slice(0, 8);
      
      if (results.length === 0) {
        dropdown.innerHTML = '<div class="search-dropdown-item"><span class="item-info"><span class="item-name">No se encontraron resultados</span></span></div>';
      } else {
        dropdown.innerHTML = results.map(p => `
          <div class="search-dropdown-item" data-id="${p.id}">
            <img src="${p.imagen_url || ''}" alt="${p.nombre}" onerror="this.style.display='none'" />
            <div class="item-info">
              <div class="item-name">${p.nombre}</div>
              <div class="item-price">${p.latestPrice ? formatPrice(p.latestPrice.precio) : '—'}</div>
            </div>
          </div>
        `).join('');
        
        dropdown.querySelectorAll('.search-dropdown-item').forEach(el => {
          el.addEventListener('click', () => {
            const product = allProducts.find(p => p.id == el.dataset.id);
            if (product) openProductModal(product);
            dropdown.classList.add('hidden');
            input.value = '';
          });
        });
      }
      
      dropdown.classList.remove('hidden');
    }, 200);
  });
  
  // Close dropdown on click outside
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
}

function setupSearchPage() {
  const input = document.getElementById('searchInput');
  let timeout;
  
  input.addEventListener('input', () => {
    clearTimeout(timeout);
    const query = input.value.trim().toLowerCase();
    
    if (query.length < 2) {
      document.getElementById('searchResults').innerHTML = 
        '<p class="empty-state">Escribe para buscar productos</p>';
      return;
    }
    
    timeout = setTimeout(() => {
      const results = allProducts
        .filter(p => p.nombre.toLowerCase().includes(query))
        .slice(0, 50);
      
      if (results.length === 0) {
        document.getElementById('searchResults').innerHTML = 
          '<p class="empty-state">No se encontraron productos</p>';
      } else {
        renderProductGrid('searchResults', results);
      }
    }, 300);
  });
}

// =========================================
// CATEGORIES VIEW
// =========================================
function renderCategories() {
  const container = document.getElementById('categoryList');
  
  // Show only root categories (parent_id = null)
  const roots = allCategories.filter(c => c.parent_id === null);
  
  if (roots.length === 0) {
    container.innerHTML = '<p class="empty-state">No hay categorías. Ejecuta el scraper primero.</p>';
    return;
  }
  
  container.innerHTML = roots.map(cat => {
    const productCount = allProducts.filter(p => {
      // Count products in this category and subcategories
      const childIds = getChildCategoryIds(cat.id);
      return childIds.includes(p.categoria_id) || p.categoria_id === cat.id;
    }).length;
    
    return `
      <div class="category-card" data-id="${cat.id}">
        <div class="category-card-name">${cat.nombre}</div>
        <div class="category-card-count">${productCount} productos</div>
      </div>
    `;
  }).join('');
  
  container.querySelectorAll('.category-card').forEach(el => {
    el.addEventListener('click', () => showCategoryProducts(el.dataset.id));
  });
}

function getChildCategoryIds(parentId) {
  const children = allCategories
    .filter(c => c.parent_id == parentId)
    .map(c => c.id);
  
  let all = [...children];
  children.forEach(id => {
    all = all.concat(getChildCategoryIds(id));
  });
  
  return all;
}

function showCategoryProducts(categoryId) {
  const container = document.getElementById('categoryProducts');
  const listContainer = document.getElementById('categoryList');
  
  const childIds = [parseInt(categoryId), ...getChildCategoryIds(parseInt(categoryId))];
  const products = allProducts.filter(p => childIds.includes(p.categoria_id));
  
  const catName = allCategories.find(c => c.id == categoryId)?.nombre || 'Categoría';
  
  listContainer.classList.add('hidden');
  container.classList.remove('hidden');
  
  container.innerHTML = `
    <button class="back-btn" id="backToCategories">← Volver a categorías</button>
    <h3 style="margin-bottom: 1rem; grid-column: 1/-1;">${catName} (${products.length} productos)</h3>
  `;
  
  if (products.length === 0) {
    container.innerHTML += '<p class="empty-state">No hay productos en esta categoría</p>';
  } else {
    products.forEach(p => {
      container.innerHTML += createProductCard(p);
    });
  }
  
  document.getElementById('backToCategories').addEventListener('click', () => {
    container.classList.add('hidden');
    listContainer.classList.remove('hidden');
  });
  
  attachProductCardListeners(container);
}

// =========================================
// TRENDS VIEW
// =========================================
function renderTrends() {
  // Average price over time
  const dateMap = {};
  
  for (const p of allProducts) {
    for (const h of p.priceHistory) {
      if (!dateMap[h.fecha]) dateMap[h.fecha] = [];
      dateMap[h.fecha].push(h.precio);
    }
  }
  
  const dates = Object.keys(dateMap).sort();
  const avgPrices = dates.map(d => {
    const prices = dateMap[d];
    return +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(4);
  });
  
  if (dates.length > 0) {
    renderLineChart('chartAvgPrice', dates.map(d => formatDate(d)), avgPrices);
  }
  
  // Category inflation
  renderCategoryInflation();
}

function renderCategoryInflation() {
  const rootCats = allCategories.filter(c => c.parent_id === null);
  const labels = [];
  const values = [];
  const colors = [];
  
  for (const cat of rootCats) {
    const childIds = [cat.id, ...getChildCategoryIds(cat.id)];
    const catProducts = allProducts.filter(p => childIds.includes(p.categoria_id));
    
    let totalChange = 0;
    let count = 0;
    
    for (const p of catProducts) {
      if (p.priceHistory.length < 2) continue;
      const sorted = [...p.priceHistory].sort((a, b) => 
        new Date(a.fecha) - new Date(b.fecha)
      );
      const first = sorted[0].precio;
      const last = sorted[sorted.length - 1].precio;
      if (first > 0) {
        totalChange += (last - first) / first * 100;
        count++;
      }
    }
    
    if (count > 0) {
      const avgChange = totalChange / count;
      labels.push(truncate(cat.nombre, 20));
      values.push(+avgChange.toFixed(2));
      colors.push(avgChange >= 0 ? 'rgba(239, 68, 68, 0.7)' : 'rgba(34, 197, 94, 0.7)');
    }
  }
  
  if (labels.length > 0) {
    renderBarChart('chartCategoryInflation', labels, values, colors, 
      values.map(v => v >= 0 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)')
    );
  }
}

// =========================================
// PRODUCT MODAL
// =========================================
function setupModal() {
  const modal = document.getElementById('productModal');
  const closeBtn = document.getElementById('modalClose');
  const backdrop = modal.querySelector('.modal-backdrop');
  
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  backdrop.addEventListener('click', () => modal.classList.add('hidden'));
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') modal.classList.add('hidden');
  });
}

async function openProductModal(product) {
  const modal = document.getElementById('productModal');
  
  document.getElementById('modalName').textContent = product.nombre;
  document.getElementById('modalFormat').textContent = product.formato || '';
  document.getElementById('modalImage').src = product.imagen_url || '';
  document.getElementById('modalImage').onerror = function() { this.style.display = 'none'; };
  document.getElementById('modalLink').href = product.url || '#';
  
  if (product.latestPrice) {
    document.getElementById('modalPrice').textContent = formatPrice(product.latestPrice.precio);
    document.getElementById('modalPriceRef').textContent = 
      product.latestPrice.precio_referencia 
        ? `${formatPrice(product.latestPrice.precio_referencia)}/kg` 
        : '';
  } else {
    document.getElementById('modalPrice').textContent = '—';
    document.getElementById('modalPriceRef').textContent = '';
  }
  
  modal.classList.remove('hidden');
  
  // Render price history chart
  if (product.priceHistory && product.priceHistory.length > 0) {
    const labels = product.priceHistory.map(h => formatDate(h.fecha));
    const data = product.priceHistory.map(h => h.precio);
    renderLineChart('chartProductHistory', labels, data);
  }
}

// =========================================
// RENDERING HELPERS
// =========================================
function createProductCard(product) {
  const price = product.latestPrice;
  let changeHtml = '';
  
  if (product.priceHistory.length >= 2) {
    const sorted = [...product.priceHistory].sort((a, b) => 
      new Date(a.fecha) - new Date(b.fecha)
    );
    const first = sorted[0].precio;
    const last = sorted[sorted.length - 1].precio;
    if (first > 0) {
      const change = ((last - first) / first * 100).toFixed(1);
      if (Math.abs(change) > 0.01) {
        const cls = change > 0 ? 'up' : 'down';
        const sign = change > 0 ? '+' : '';
        changeHtml = `<span class="price-change ${cls}">${sign}${change}%</span>`;
      }
    }
  }
  
  return `
    <div class="product-card" data-id="${product.id}">
      <img src="${product.imagen_url || ''}" alt="${product.nombre}" onerror="this.style.display='none'" loading="lazy" />
      <div class="product-card-info">
        <div class="product-card-name">${product.nombre}</div>
        <div class="product-card-format">${product.formato || ''}</div>
        <div class="product-card-price">
          <span class="price-main">${price ? formatPrice(price.precio) : '—'}</span>
          ${changeHtml}
        </div>
      </div>
    </div>
  `;
}

function renderProductGrid(containerId, products) {
  const container = document.getElementById(containerId);
  
  if (products.length === 0) {
    container.innerHTML = '<p class="empty-state">No hay productos para mostrar</p>';
    return;
  }
  
  container.innerHTML = products.map(p => createProductCard(p)).join('');
  attachProductCardListeners(container);
}

function attachProductCardListeners(container) {
  container.querySelectorAll('.product-card').forEach(el => {
    el.addEventListener('click', () => {
      const product = allProducts.find(p => p.id == el.dataset.id);
      if (product) openProductModal(product);
    });
  });
}

// =========================================
// CHART HELPERS
// =========================================
function renderBarChart(canvasId, labels, data, bgColor, borderColor) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
  }
  
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  
  const bgColors = Array.isArray(bgColor) ? bgColor : Array(data.length).fill(bgColor);
  const bdColors = Array.isArray(borderColor) ? borderColor : Array(data.length).fill(borderColor || bgColor);
  
  chartInstances[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: bgColors,
        borderColor: bdColors,
        borderWidth: 1,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          cornerRadius: 8,
          callbacks: {
            label: ctx => `${ctx.parsed.y > 0 ? '+' : ''}${ctx.parsed.y}%`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', font: { size: 11 }, maxRotation: 45 }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#64748b',
            font: { size: 11 },
            callback: v => `${v > 0 ? '+' : ''}${v}%`
          }
        }
      }
    }
  });
}

function renderLineChart(canvasId, labels, data) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
  }
  
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  
  chartInstances[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: data.length > 30 ? 0 : 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#6366f1',
        pointBorderColor: '#0a0e1a',
        pointBorderWidth: 2,
        borderWidth: 2.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          cornerRadius: 8,
          callbacks: {
            label: ctx => formatPrice(ctx.parsed.y)
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 10 }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#64748b',
            font: { size: 11 },
            callback: v => formatPrice(v)
          }
        }
      },
      interaction: {
        mode: 'nearest',
        axis: 'x',
        intersect: false
      }
    }
  });
}

// =========================================
// UTILITY FUNCTIONS
// =========================================
function formatPrice(price) {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR'
  }).format(price);
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen) + '…' : str;
}
