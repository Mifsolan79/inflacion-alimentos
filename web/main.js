import './style.css';
import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';
import { buildAnalyticsFromProducts } from './analytics-core.js';

const SUPABASE_URL = 'https://qvgxqiqxapnckenmqbwf.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2Z3hxaXF4YXBuY2tlbm1xYndmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3NjU4NDYsImV4cCI6MjA4OTM0MTg0Nn0.jr-u1sw0AoOyweJkOAn7w53SOH8OFnqBtzzdH3VeK8s';

const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let analyticsData = null;
let allProducts = [];
let allCategories = [];
let productById = new Map();
let chartInstances = {};
let searchTimeout = null;

document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupModal();
  setupGlobalSearch();
  setupSearchPage();
  await loadAppData();
});

async function loadAppData() {
  let analyticsLoaded = false;
  let catalogLoaded = false;

  try {
    await loadCatalogData();
    catalogLoaded = true;
  } catch (catalogError) {
    console.error('No se pudo cargar el catalogo desde Supabase:', catalogError);
    renderCatalogUnavailable();
  }

  if (catalogLoaded) {
    try {
      loadAnalyticsFromSupabase();
      analyticsLoaded = true;
    } catch (analyticsError) {
      console.error('No se pudo construir la analitica desde Supabase:', analyticsError);
    }
  }

  if (!analyticsLoaded) {
    try {
      await loadAnalyticsFallback();
      analyticsLoaded = true;
    } catch (analyticsError) {
      console.error('No se pudo cargar la analitica:', analyticsError);
      renderAnalyticsError();
    }
  }

  updateStatus(analyticsLoaded, catalogLoaded);
}

function updateStatus(analyticsLoaded, catalogLoaded) {
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');

  statusDot.classList.remove('connected', 'error');

  if (analyticsLoaded) {
    statusDot.classList.add('connected');
    statusText.textContent =
      `${analyticsData.metadata.snapshotCount} cortes · ${formatNumber(analyticsData.metadata.commonAllDates)} IDs comunes`;
    return;
  }

  if (catalogLoaded) {
    statusDot.classList.add('connected');
    statusText.textContent = `${formatNumber(allProducts.length)} productos cargados`;
    return;
  }

  statusDot.classList.add('error');
  statusText.textContent = 'No se pudieron cargar los datos';
}

function loadAnalyticsFromSupabase() {
  analyticsData = buildAnalyticsFromProducts(allProducts);
  document.getElementById('lastUpdate').textContent =
    `Ultimo snapshot: ${formatIsoDate(analyticsData.metadata.range.end, 'long')}`;

  renderDashboard();
  renderTrends();
}

async function loadAnalyticsFallback() {
  const response = await fetch('data/mercadona-analytics.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  analyticsData = await response.json();
  document.getElementById('lastUpdate').textContent =
    `Ultimo snapshot: ${formatIsoDate(analyticsData.metadata.range.end, 'long')}`;

  renderDashboard();
  renderTrends();
}

async function loadCatalogData() {
  const { data: categories, error: categoriesError } = await supabase
    .from('categorias')
    .select('*')
    .order('nombre');

  if (categoriesError) throw categoriesError;
  allCategories = categories || [];

  const fetchedProducts = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: products, error: productsError } = await supabase
      .from('productos')
      .select(`
        *,
        historial_precios (
          precio,
          precio_referencia,
          fecha
        )
      `)
      .order('nombre')
      .range(from, from + pageSize - 1);

    if (productsError) throw productsError;

    if (products && products.length) {
      fetchedProducts.push(...products);
      from += pageSize;
      hasMore = products.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  allProducts = fetchedProducts.map((product) => {
    const priceHistory = (product.historial_precios || [])
      .filter((entry) => entry && entry.fecha)
      .sort((left, right) => left.fecha.localeCompare(right.fecha));

    return {
      ...product,
      priceHistory,
      latestPrice: priceHistory[priceHistory.length - 1] || null,
    };
  });

  productById = new Map(allProducts.map((product) => [product.id, product]));

  renderCategories();
  renderRecentProducts();
  renderBasket();
}

function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const viewId = item.dataset.view;

      navItems.forEach((navItem) => navItem.classList.remove('active'));
      item.classList.add('active');

      document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
      const targetView = document.getElementById(`view-${viewId}`);
      if (targetView) targetView.classList.add('active');

      if (viewId === 'basket') renderBasket();
    });
  });
}

function setupModal() {
  const modal = document.getElementById('productModal');
  const closeButton = document.getElementById('modalClose');
  const backdrop = modal.querySelector('.modal-backdrop');

  closeButton.addEventListener('click', () => modal.classList.add('hidden'));
  backdrop.addEventListener('click', () => modal.classList.add('hidden'));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') modal.classList.add('hidden');
  });
}

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
      if (!allProducts.length) {
        dropdown.innerHTML = '<div class="search-dropdown-item"><span class="item-info"><span class="item-name">Catalogo no disponible</span></span></div>';
        dropdown.classList.remove('hidden');
        return;
      }

      const results = allProducts
        .filter((product) => product.nombre.toLowerCase().includes(query))
        .slice(0, 8);

      if (!results.length) {
        dropdown.innerHTML = '<div class="search-dropdown-item"><span class="item-info"><span class="item-name">No se encontraron resultados</span></span></div>';
      } else {
        dropdown.innerHTML = results
          .map(
            (product) => `
              <div class="search-dropdown-item" data-id="${product.id}">
                <img src="${product.imagen_url || ''}" alt="${escapeHtml(product.nombre)}" onerror="this.style.display='none'" />
                <div class="item-info">
                  <div class="item-name">${escapeHtml(product.nombre)}</div>
                  <div class="item-price">${product.latestPrice ? formatPrice(product.latestPrice.precio) : '—'}</div>
                </div>
              </div>
            `,
          )
          .join('');

        dropdown.querySelectorAll('.search-dropdown-item[data-id]').forEach((item) => {
          item.addEventListener('click', () => {
            openProductById(Number(item.dataset.id));
            dropdown.classList.add('hidden');
            input.value = '';
          });
        });
      }

      dropdown.classList.remove('hidden');
    }, 180);
  });

  document.addEventListener('click', (event) => {
    if (!input.contains(event.target) && !dropdown.contains(event.target)) {
      dropdown.classList.add('hidden');
    }
  });
}

function setupSearchPage() {
  const input = document.getElementById('searchInput');
  let timeout = null;

  input.addEventListener('input', () => {
    clearTimeout(timeout);
    const query = input.value.trim().toLowerCase();

    if (query.length < 2) {
      document.getElementById('searchResults').innerHTML =
        '<p class="empty-state">Escribe al menos 2 letras para buscar.</p>';
      return;
    }

    timeout = setTimeout(() => {
      if (!allProducts.length) {
        document.getElementById('searchResults').innerHTML =
          '<p class="empty-state">El catalogo no esta disponible ahora mismo.</p>';
        return;
      }

      const results = allProducts
        .filter((product) => product.nombre.toLowerCase().includes(query))
        .slice(0, 60);

      if (!results.length) {
        document.getElementById('searchResults').innerHTML =
          '<p class="empty-state">No se encontraron productos.</p>';
        return;
      }

      renderProductGrid('searchResults', results);
    }, 220);
  });
}

function renderDashboard() {
  if (!analyticsData) return;

  renderHero();
  renderKpiCards();
  renderMethodologyCards();
  renderFixedBasketIndexChart();
  renderDiffusionChart();
  renderMoversCharts();
  renderRecentProducts();
  renderContributionWaterfall();
}

function renderHero() {
  document.getElementById('dashboardSubtitle').textContent =
    `${analyticsData.metadata.snapshotCount} snapshots entre ${formatIsoDate(analyticsData.metadata.range.start, 'long')} y ${formatIsoDate(analyticsData.metadata.range.end, 'long')}. ` +
    `Serie principal construida con ${formatNumber(analyticsData.metadata.commonAllDates)} IDs presentes en todas las fechas.`;

  document.getElementById('heroMetrics').innerHTML = `
    <div class="hero-metric">
      <span class="hero-metric-label">Snapshots</span>
      <strong class="hero-metric-value">${formatNumber(analyticsData.metadata.snapshotCount)}</strong>
    </div>
    <div class="hero-metric">
      <span class="hero-metric-label">Panel comun</span>
      <strong class="hero-metric-value">${formatNumber(analyticsData.metadata.commonAllDates)}</strong>
    </div>
    <div class="hero-metric">
      <span class="hero-metric-label">Ultimo corte</span>
      <strong class="hero-metric-value">${formatNumber(analyticsData.metadata.lastCount)}</strong>
    </div>
  `;
}

function renderKpiCards() {
  const { kpis, metadata } = analyticsData;
  const cards = [
    {
      label: 'Indice cesta fija',
      value: formatIndex(kpis.fixedBasketIndex.current),
      detail: `${formatSignedPercent(kpis.fixedBasketIndex.changePct)} acumulado`,
      note: `${formatNumber(kpis.fixedBasketIndex.panelSize)} IDs comunes`,
      tone: 'primary',
    },
    {
      label: 'Inflacion unitaria',
      value: formatSignedPercent(kpis.referenceIndex.changePct),
      detail: `Indice ${formatIndex(kpis.referenceIndex.current)}`,
      note: `${formatNumber(kpis.referenceIndex.panelSize)} IDs con precio referencia`,
      tone: 'secondary',
    },
    {
      label: 'Difusion total',
      value: formatPercent(kpis.diffusion.changedPct),
      detail: `${formatNumber(kpis.diffusion.changedCount)} de ${formatNumber(kpis.diffusion.total)} cambiaron`,
      note: `Suben ${formatNumber(kpis.diffusion.upCount)} · Bajan ${formatNumber(kpis.diffusion.downCount)}`,
      tone: 'danger',
    },
    {
      label: 'Ultimo salto',
      value: formatPercent(kpis.lastInterval.changedPct),
      detail: `${formatNumber(kpis.lastInterval.changedCount)} cambios en ${formatIsoDate(kpis.lastInterval.from, 'tiny')} -> ${formatIsoDate(kpis.lastInterval.to, 'tiny')}`,
      note: `Suben ${formatNumber(kpis.lastInterval.upCount)} · Bajan ${formatNumber(kpis.lastInterval.downCount)}`,
      tone: 'amber',
    },
    {
      label: 'Rotacion surtido',
      value: `+${formatNumber(kpis.rotation.newCount)} / -${formatNumber(kpis.rotation.disappearedCount)}`,
      detail: `${formatSignedNumber(kpis.rotation.netCount, 0)} neto entre primer y ultimo corte`,
      note: `${formatNumber(metadata.firstCount)} -> ${formatNumber(metadata.lastCount)} productos`,
      tone: 'success',
    },
  ];

  document.getElementById('analyticsKpis').innerHTML = cards
    .map(
      (card) => `
        <article class="stat-card stat-card-kpi stat-card-${card.tone}">
          <div class="stat-info">
            <span class="stat-label">${card.label}</span>
            <span class="stat-value">${card.value}</span>
            <span class="stat-detail">${card.detail}</span>
            <span class="stat-note">${card.note}</span>
          </div>
        </article>
      `,
    )
    .join('');
}

function renderMethodologyCards() {
  const { kpis } = analyticsData;
  const cards = [
    {
      label: 'Precio ticket',
      value: formatSignedPercent(kpis.fixedBasketIndex.changePct),
      copy: 'Mide la variacion del mismo SKU en una cesta fija sin mezclar altas y bajas del surtido.',
    },
    {
      label: 'Precio referencia',
      value: formatSignedPercent(kpis.referenceIndex.changePct),
      copy: 'Ajusta mejor los cambios de tamano o peso por unidad y puede divergir del precio final.',
    },
    {
      label: 'Rotacion aparte',
      value: `+${formatNumber(kpis.rotation.newCount)} / -${formatNumber(kpis.rotation.disappearedCount)}`,
      copy: 'Las altas y bajas no entran en la serie principal para evitar que la inflacion quede sesgada.',
    },
  ];

  document.getElementById('methodologyCards').innerHTML = cards
    .map(
      (card) => `
        <article class="insight-card">
          <span class="insight-label">${card.label}</span>
          <strong class="insight-value">${card.value}</strong>
          <p class="insight-copy">${card.copy}</p>
        </article>
      `,
    )
    .join('');
}

function renderTrends() {
  if (!analyticsData) return;

  renderHistogramChart();
  renderScatterChart();
  renderRotationChart();
  renderRobustStats();
  renderIntervalSummary();
  renderHeatmap();
}

function renderRobustStats() {
  const { robustPrice, robustReference } = analyticsData.kpis;
  const stats = [
    {
      label: 'Mediana precio',
      value: formatPercent(robustPrice.medianPct),
      note: `Rango ${formatSignedPercent(robustPrice.minPct)} a ${formatSignedPercent(robustPrice.maxPct)}`,
    },
    {
      label: 'Media recortada precio',
      value: formatPercent(robustPrice.trimmedMeanPct),
      note: `Media simple ${formatSignedPercent(robustPrice.meanPct)}`,
    },
    {
      label: 'Mediana referencia',
      value: formatPercent(robustReference.medianPct),
      note: `Rango ${formatSignedPercent(robustReference.minPct)} a ${formatSignedPercent(robustReference.maxPct)}`,
    },
    {
      label: 'Media recortada referencia',
      value: formatPercent(robustReference.trimmedMeanPct),
      note: `Media simple ${formatSignedPercent(robustReference.meanPct)}`,
    },
  ];

  document.getElementById('robustStats').innerHTML = stats
    .map(
      (stat) => `
        <article class="mini-stat-card">
          <span class="mini-stat-label">${stat.label}</span>
          <strong class="mini-stat-value">${stat.value}</strong>
          <span class="mini-stat-note">${stat.note}</span>
        </article>
      `,
    )
    .join('');
}

function renderIntervalSummary() {
  document.getElementById('intervalSummary').innerHTML = analyticsData.series.intervalDiffusion
    .map(
      (item) => `
        <div class="timeline-item">
          <div class="timeline-label">${formatIsoDate(item.from, 'tiny')} -> ${formatIsoDate(item.to, 'tiny')}</div>
          <div class="timeline-value">${formatNumber(item.changedCount)} cambios</div>
          <div class="timeline-meta">
            <span>Suben ${formatNumber(item.upCount)}</span>
            <span>Bajan ${formatNumber(item.downCount)}</span>
            <span>Igual ${formatNumber(item.sameCount)}</span>
          </div>
        </div>
      `,
    )
    .join('');
}

function renderHeatmap() {
  const heatmap = analyticsData.series.heatmap;
  if (!heatmap?.rows?.length) {
    document.getElementById('priceHeatmap').innerHTML =
      '<p class="empty-state">No hay suficientes datos para el heatmap.</p>';
    return;
  }

  const header = `
    <div class="heatmap-header">
      <div class="heatmap-corner">Producto</div>
      ${heatmap.columns
        .map((column) => `<div class="heatmap-column-label">${formatIsoDate(column.to, 'tiny')}</div>`)
        .join('')}
    </div>
  `;

  const rows = heatmap.rows
    .map((row) => {
      const label = `
        <button class="heatmap-row-label ${productById.has(row.id) ? '' : 'is-linkless'}" data-product-id="${row.id}" type="button">
          <span class="heatmap-product-name">${escapeHtml(truncate(row.name, 38))}</span>
          <span class="heatmap-product-meta">${row.changeCount} cambios · ${formatSignedPercent(row.totalPct)}</span>
        </button>
      `;

      const cells = row.values
        .map((value, index) => {
          const tone = getHeatmapColor(value);
          return `
            <div
              class="heatmap-cell"
              style="background:${tone.background}; border-color:${tone.border};"
              title="${escapeHtml(row.name)} | ${formatIsoDate(heatmap.columns[index].from, 'tiny')} -> ${formatIsoDate(heatmap.columns[index].to, 'tiny')} | ${formatSignedPercent(value)}"
            >
              ${Math.abs(value) < 0.01 ? '·' : formatCompactSignedPercent(value)}
            </div>
          `;
        })
        .join('');

      return `<div class="heatmap-row">${label}${cells}</div>`;
    })
    .join('');

  document.getElementById('priceHeatmap').innerHTML = `${header}<div class="heatmap-body">${rows}</div>`;

  document.querySelectorAll('.heatmap-row-label[data-product-id]').forEach((button) => {
    button.addEventListener('click', () => openProductById(Number(button.dataset.productId)));
  });
}

function renderFixedBasketIndexChart() {
  createChart('chartFixedBasketIndex', {
    type: 'line',
    data: {
      labels: analyticsData.series.fixedBasketIndex.map((point) => formatIsoDate(point.date, 'tiny')),
      datasets: [
        {
          label: 'Precio',
          data: analyticsData.series.fixedBasketIndex.map((point) => point.value),
          borderColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.12)',
          fill: true,
          tension: 0.28,
          borderWidth: 2.6,
          pointRadius: 4,
          pointHoverRadius: 5,
          pointBackgroundColor: '#f97316',
        },
        {
          label: 'Precio referencia',
          data: analyticsData.series.referenceIndex.map((point) => point.value),
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34, 197, 94, 0.08)',
          fill: false,
          tension: 0.28,
          borderWidth: 2.3,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: '#22c55e',
        },
      ],
    },
    options: {
      ...getBaseChartOptions(),
      plugins: {
        ...getBaseChartOptions().plugins,
        legend: getLegendStyle(),
        tooltip: {
          ...getTooltipStyle(),
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatIndex(context.parsed.y)}`,
          },
        },
      },
      scales: {
        x: getCategoryAxisStyle(),
        y: {
          ...getValueAxisStyle(),
          ticks: {
            ...getValueAxisStyle().ticks,
            callback: (value) => formatIndex(value),
          },
        },
      },
    },
  });
}

function renderDiffusionChart() {
  createChart('chartDiffusion', {
    type: 'bar',
    data: {
      labels: analyticsData.series.intervalDiffusion.map((item) => formatIsoDate(item.to, 'tiny')),
      datasets: [
        {
          label: 'Suben',
          data: analyticsData.series.intervalDiffusion.map((item) => item.upPct),
          backgroundColor: 'rgba(239, 68, 68, 0.82)',
          borderColor: 'rgba(239, 68, 68, 1)',
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: 'Igual',
          data: analyticsData.series.intervalDiffusion.map((item) => item.samePct),
          backgroundColor: 'rgba(148, 163, 184, 0.55)',
          borderColor: 'rgba(148, 163, 184, 0.9)',
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: 'Bajan',
          data: analyticsData.series.intervalDiffusion.map((item) => item.downPct),
          backgroundColor: 'rgba(34, 197, 94, 0.82)',
          borderColor: 'rgba(34, 197, 94, 1)',
          borderWidth: 1,
          borderRadius: 6,
        },
      ],
    },
    options: {
      ...getBaseChartOptions(),
      plugins: {
        ...getBaseChartOptions().plugins,
        legend: getLegendStyle(),
        tooltip: {
          ...getTooltipStyle(),
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatPercent(context.parsed.y)}`,
            afterBody: (items) => {
              const interval = analyticsData.series.intervalDiffusion[items[0].dataIndex];
              return [`${formatNumber(interval.changedCount)} cambios sobre ${formatNumber(interval.total)}`];
            },
          },
        },
      },
      scales: {
        x: {
          ...getCategoryAxisStyle(),
          stacked: true,
        },
        y: {
          ...getValueAxisStyle(),
          stacked: true,
          min: 0,
          max: 100,
          ticks: {
            ...getValueAxisStyle().ticks,
            callback: (value) => `${value}%`,
          },
        },
      },
    },
  });
}

function renderMoversCharts() {
  renderRankingChart('chartTopUp', analyticsData.series.topMoversUp, '#ef4444');
  renderRankingChart('chartTopDown', analyticsData.series.topMoversDown, '#22c55e');
}

function renderRankingChart(canvasId, rows, color) {
  const visibleRows = rows.slice(0, 8);

  createChart(canvasId, {
    type: 'bar',
    data: {
      labels: visibleRows.map((row) => wrapLabel(row.name, 20, 2)),
      datasets: [
        {
          data: visibleRows.map((row) => row.changePct),
          backgroundColor: visibleRows.map(() => `${color}cc`),
          borderColor: visibleRows.map(() => color),
          borderWidth: 1,
          borderRadius: 8,
          maxBarThickness: 24,
        },
      ],
    },
    options: {
      ...getBaseChartOptions(),
      indexAxis: 'y',
      plugins: {
        ...getBaseChartOptions().plugins,
        tooltip: {
          ...getTooltipStyle(),
          callbacks: {
            title: (items) => visibleRows[items[0].dataIndex].name,
            label: (context) =>
              `${formatSignedPercent(context.parsed.x)} | ${formatPrice(visibleRows[context.dataIndex].startPrice)} -> ${formatPrice(visibleRows[context.dataIndex].endPrice)}`,
          },
        },
      },
      scales: {
        x: {
          ...getValueAxisStyle(),
          ticks: {
            ...getValueAxisStyle().ticks,
            callback: (value) => `${value > 0 ? '+' : ''}${value}%`,
          },
        },
        y: {
          ...getCategoryAxisStyle(),
          ticks: {
            ...getCategoryAxisStyle().ticks,
            font: { size: 12, weight: '600' },
          },
        },
      },
      onClick: (_event, elements) => {
        const match = elements[0];
        if (!match) return;
        openProductById(visibleRows[match.index].id, visibleRows[match.index].url);
      },
    },
  });
}

function renderContributionWaterfall() {
  const rows = analyticsData.series.contributionWaterfall;
  createChart('chartContribWaterfall', {
    type: 'bar',
    data: {
      labels: rows.map((row) => wrapLabel(truncate(row.shortLabel, 24), 14, 2)),
      datasets: [
        {
          data: rows.map((row) => [row.start, row.end]),
          backgroundColor: rows.map((row) => {
            if (row.type === 'total') return 'rgba(99, 102, 241, 0.85)';
            return row.value >= 0 ? 'rgba(239, 68, 68, 0.78)' : 'rgba(34, 197, 94, 0.78)';
          }),
          borderColor: rows.map((row) => {
            if (row.type === 'total') return '#818cf8';
            return row.value >= 0 ? '#ef4444' : '#22c55e';
          }),
          borderWidth: 1,
          borderRadius: 8,
        },
      ],
    },
    options: {
      ...getBaseChartOptions(),
      plugins: {
        ...getBaseChartOptions().plugins,
        tooltip: {
          ...getTooltipStyle(),
          callbacks: {
            title: (items) => rows[items[0].dataIndex].label,
            label: (context) => `${formatSignedNumber(rows[context.dataIndex].value, 3)} pp`,
          },
        },
      },
      scales: {
        x: getCategoryAxisStyle(),
        y: {
          ...getValueAxisStyle(),
          ticks: {
            ...getValueAxisStyle().ticks,
            callback: (value) => `${formatSignedNumber(value, 2)} pp`,
          },
        },
      },
      onClick: (_event, elements) => {
        const match = elements[0];
        if (!match) return;
        const row = rows[match.index];
        if (row.id) openProductById(row.id, row.url);
      },
    },
  });
}

function renderHistogramChart() {
  const histogram = analyticsData.series.histogramPrice;
  createChart('chartHistogram', {
    type: 'bar',
    data: {
      labels: histogram.bins.map((bin) => bin.label),
      datasets: [
        {
          data: histogram.bins.map((bin) => bin.count),
          backgroundColor: histogram.bins.map((bin) =>
            bin.end <= 0 ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)',
          ),
          borderColor: histogram.bins.map((bin) => (bin.end <= 0 ? '#22c55e' : '#ef4444')),
          borderWidth: 1,
          borderRadius: 4,
          barPercentage: 1,
          categoryPercentage: 1,
        },
      ],
    },
    options: {
      ...getBaseChartOptions(),
      plugins: {
        ...getBaseChartOptions().plugins,
        tooltip: {
          ...getTooltipStyle(),
          callbacks: {
            title: (items) => histogram.bins[items[0].dataIndex].label,
            label: (context) => `${formatNumber(context.parsed.y)} productos`,
          },
        },
      },
      scales: {
        x: {
          ...getCategoryAxisStyle(),
          ticks: {
            ...getCategoryAxisStyle().ticks,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
          },
        },
        y: getValueAxisStyle(),
      },
    },
  });
}

function renderScatterChart() {
  const points = analyticsData.series.scatterPriceVsReference;
  createChart('chartScatter', {
    type: 'scatter',
    data: {
      datasets: [
        {
          data: points,
          backgroundColor: 'rgba(59, 130, 246, 0.38)',
          borderColor: 'rgba(59, 130, 246, 0.85)',
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBorderWidth: 1,
        },
      ],
    },
    options: {
      ...getBaseChartOptions(),
      animation: false,
      plugins: {
        ...getBaseChartOptions().plugins,
        legend: { display: false },
        tooltip: {
          ...getTooltipStyle(),
          callbacks: {
            title: (items) => points[items[0].dataIndex].name,
            label: (context) =>
              `Precio ${formatSignedPercent(context.raw.x)} | Referencia ${formatSignedPercent(context.raw.y)}`,
          },
        },
      },
      scales: {
        x: {
          ...getValueAxisStyle(),
          title: {
            display: true,
            text: 'Variacion Precio (%)',
            color: '#94a3b8',
          },
          ticks: {
            ...getValueAxisStyle().ticks,
            callback: (value) => `${value}%`,
          },
        },
        y: {
          ...getValueAxisStyle(),
          title: {
            display: true,
            text: 'Variacion Precio Referencia (%)',
            color: '#94a3b8',
          },
          ticks: {
            ...getValueAxisStyle().ticks,
            callback: (value) => `${value}%`,
          },
        },
      },
      onClick: (_event, elements) => {
        const match = elements[0];
        if (!match) return;
        const point = points[match.index];
        openProductById(point.id, point.url);
      },
    },
  });
}

function renderRotationChart() {
  createChart('chartRotation', {
    type: 'bar',
    data: {
      labels: analyticsData.series.intervalRotation.map((item) => formatIsoDate(item.to, 'tiny')),
      datasets: [
        {
          label: 'Altas',
          data: analyticsData.series.intervalRotation.map((item) => item.newCount),
          backgroundColor: 'rgba(59, 130, 246, 0.8)',
          borderColor: '#3b82f6',
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: 'Bajas',
          data: analyticsData.series.intervalRotation.map((item) => -item.disappearedCount),
          backgroundColor: 'rgba(249, 115, 22, 0.8)',
          borderColor: '#f97316',
          borderWidth: 1,
          borderRadius: 6,
        },
      ],
    },
    options: {
      ...getBaseChartOptions(),
      plugins: {
        ...getBaseChartOptions().plugins,
        legend: getLegendStyle(),
        tooltip: {
          ...getTooltipStyle(),
          callbacks: {
            label: (context) =>
              `${context.dataset.label}: ${formatNumber(Math.abs(context.parsed.y))} productos`,
          },
        },
      },
      scales: {
        x: getCategoryAxisStyle(),
        y: {
          ...getValueAxisStyle(),
          ticks: {
            ...getValueAxisStyle().ticks,
            callback: (value) => formatNumber(Math.abs(value)),
          },
        },
      },
    },
  });
}

function renderAnalyticsError() {
  document.getElementById('dashboardSubtitle').textContent =
    'No se pudo cargar la analitica local generada a partir de los CSV.';
  document.getElementById('analyticsKpis').innerHTML =
    '<p class="empty-state">Genera el fichero data/mercadona-analytics.json antes de abrir la web.</p>';
  document.getElementById('methodologyCards').innerHTML =
    '<p class="empty-state">Sin analitica local no se pueden calcular los KPI de inflacion.</p>';
  document.getElementById('robustStats').innerHTML =
    '<p class="empty-state">No hay suficientes datos.</p>';
  document.getElementById('intervalSummary').innerHTML =
    '<p class="empty-state">No hay intervalos para resumir.</p>';
  document.getElementById('priceHeatmap').innerHTML =
    '<p class="empty-state">No se pudo construir el heatmap.</p>';
}

function renderCatalogUnavailable() {
  document.getElementById('searchResults').innerHTML =
    '<p class="empty-state">El catalogo desde Supabase no esta disponible.</p>';
  document.getElementById('categoryList').innerHTML =
    '<p class="empty-state">No se pudieron cargar las categorias.</p>';
  document.getElementById('recentProducts').innerHTML =
    '<p class="empty-state">No se pudieron cargar los productos con mayor movimiento.</p>';
  document.getElementById('basketItems').innerHTML =
    '<tr><td colspan="3" class="error-text">La cesta requiere acceso al catalogo y a la tabla cesta_basica.</td></tr>';
  document.getElementById('basketHistory').innerHTML =
    '<p class="empty-state">Sin catalogo no hay historico de cesta.</p>';
}

function renderRecentProducts() {
  const container = document.getElementById('recentProducts');
  if (!container) return;

  if (!allProducts.length) {
    container.innerHTML = '<div class="loading-skeleton">Calculando productos con mayor movimiento...</div>';
    return;
  }

  const movers = [...allProducts]
    .filter((product) => product.latestPrice)
    .map((product) => ({
      product,
      summary: getProductChangeSummary(product),
    }))
    .filter((item) => item.summary && Math.abs(item.summary.change) > 0.01)
    .sort((left, right) => {
      const delta = Math.abs(right.summary.change) - Math.abs(left.summary.change);
      if (Math.abs(delta) > 0.0001) {
        return delta;
      }

      return left.product.nombre.localeCompare(right.product.nombre, 'es');
    })
    .slice(0, 50)
    .map((item) => item.product);

  if (!movers.length) {
    container.innerHTML = '<p class="empty-state">No hay productos con suficiente historico para calcular movimiento.</p>';
    return;
  }

  container.innerHTML = movers.map((product) => createRecentProductCard(product)).join('');
  attachRecentProductCardListeners(container);
}

function renderCategories() {
  const container = document.getElementById('categoryList');
  const roots = allCategories.filter((category) => category.parent_id === null);

  if (!roots.length) {
    container.innerHTML = '<p class="empty-state">No hay categorias disponibles.</p>';
    return;
  }

  container.innerHTML = roots
    .map((category) => {
      const childIds = getChildCategoryIds(category.id);
      const productCount = allProducts.filter((product) =>
        childIds.includes(product.categoria_id) || product.categoria_id === category.id,
      ).length;

      return `
        <button class="category-card" data-id="${category.id}" type="button">
          <div class="category-card-name">${escapeHtml(category.nombre)}</div>
          <div class="category-card-count">${formatNumber(productCount)} productos</div>
        </button>
      `;
    })
    .join('');

  container.querySelectorAll('.category-card').forEach((card) => {
    card.addEventListener('click', () => showCategoryProducts(Number(card.dataset.id)));
  });
}

function getChildCategoryIds(parentId) {
  const children = allCategories
    .filter((category) => category.parent_id === parentId)
    .map((category) => category.id);

  return children.flatMap((childId) => [childId, ...getChildCategoryIds(childId)]);
}

function showCategoryProducts(categoryId) {
  const container = document.getElementById('categoryProducts');
  const listContainer = document.getElementById('categoryList');
  const categoryIds = [categoryId, ...getChildCategoryIds(categoryId)];
  const products = allProducts.filter((product) => categoryIds.includes(product.categoria_id));
  const categoryName = allCategories.find((category) => category.id === categoryId)?.nombre || 'Categoria';

  listContainer.classList.add('hidden');
  container.classList.remove('hidden');

  container.innerHTML = `
    <button class="back-btn" id="backToCategories" type="button">← Volver a categorias</button>
    <h3 style="margin-bottom:1rem;grid-column:1/-1;">${escapeHtml(categoryName)} (${formatNumber(products.length)} productos)</h3>
  `;

  if (!products.length) {
    container.innerHTML += '<p class="empty-state">No hay productos en esta categoria.</p>';
  } else {
    container.innerHTML += products.map((product) => createProductCard(product)).join('');
    attachProductCardListeners(container);
  }

  document.getElementById('backToCategories').addEventListener('click', () => {
    container.classList.add('hidden');
    listContainer.classList.remove('hidden');
  });
}

async function renderBasket() {
  const container = document.getElementById('basketItems');
  const totalElement = document.getElementById('basketTotal');
  const changeElement = document.getElementById('basketChange');

  if (!container || !allProducts.length) return;

  try {
    const { data: basketItems, error } = await supabase
      .from('cesta_basica')
      .select('producto_id, cantidad');

    if (error) throw error;

    const basketProducts = (basketItems || [])
      .map((item) => {
        const product = productById.get(item.producto_id);
        return product ? { ...product, quantity: Number(item.cantidad || 1) } : null;
      })
      .filter(Boolean);

    const totalItemsCount = basketProducts.reduce((sum, product) => sum + product.quantity, 0);
    const countElement = document.querySelector('.basket-count');
    if (countElement) {
      countElement.textContent = `${formatNumber(basketProducts.length)} PRODUCTOS / ${formatNumber(totalItemsCount)} ARTICULOS`;
    }

    container.innerHTML = basketProducts
      .map((product) => {
        const subtotal = (product.latestPrice?.precio || 0) * product.quantity;
        return `
          <tr>
            <td>
              <span class="item-name">${escapeHtml(product.nombre)}</span>
              <span class="item-format">${escapeHtml(product.formato || '')}</span>
            </td>
            <td class="item-format" style="text-align:center;">${formatNumber(product.quantity)}</td>
            <td class="item-price">${formatPrice(subtotal)}</td>
          </tr>
        `;
      })
      .join('');

    const total = basketProducts.reduce(
      (sum, product) => sum + ((product.latestPrice?.precio || 0) * product.quantity),
      0,
    );
    totalElement.textContent = formatPrice(total);
    renderBasketHistory(basketProducts);

    let previousTotal = 0;
    basketProducts.forEach((product) => {
      if (product.priceHistory.length >= 2) {
        previousTotal += product.priceHistory[product.priceHistory.length - 2].precio * product.quantity;
      } else {
        previousTotal += (product.latestPrice?.precio || 0) * product.quantity;
      }
    });

    if (previousTotal > 0) {
      const diff = ((total - previousTotal) / previousTotal) * 100;
      changeElement.textContent = formatSignedPercent(diff, 2);
      changeElement.className = `value ${diff > 0 ? 'up' : 'down'}`;
    }

    const latestCatalogDate =
      allProducts
        .flatMap((product) => product.priceHistory.map((entry) => entry.fecha))
        .sort()
        .at(-1) || analyticsData?.metadata?.range?.end;

    document.getElementById('basketDate').textContent = latestCatalogDate
      ? formatIsoDate(latestCatalogDate, 'monthYear')
      : '-';
  } catch (error) {
    console.error('Error cargando cesta:', error);
    container.innerHTML =
      '<tr><td colspan="3" class="error-text">No se pudo cargar la cesta desde Supabase.</td></tr>';
  }
}

function renderBasketHistory(basketProducts) {
  const historyContainer = document.getElementById('basketHistory');
  if (!historyContainer) return;

  const allDates = [...new Set(allProducts.flatMap((product) => product.priceHistory.map((entry) => entry.fecha)))].sort();
  const monthlyTotals = {};

  allDates.forEach((date) => {
    const monthKey = date.slice(0, 7);
    let monthTotal = 0;

    basketProducts.forEach((product) => {
      const matchingPrice = [...product.priceHistory].reverse().find((entry) => entry.fecha <= date);
      if (matchingPrice) {
        monthTotal += matchingPrice.precio * product.quantity;
      }
    });

    monthlyTotals[monthKey] = monthTotal;
  });

  const historyHtml = Object.keys(monthlyTotals)
    .sort()
    .reverse()
    .slice(1, 6)
    .map((month) => {
      const [year, monthIndex] = month.split('-').map(Number);
      return `
        <div class="history-item">
          <span class="history-month">${capitalize(MONTHS_LONG[monthIndex - 1])} ${year}</span>
          <span class="history-price">${formatPrice(monthlyTotals[month])}</span>
        </div>
      `;
    })
    .join('');

  historyContainer.innerHTML = historyHtml || '<p class="empty-state">No hay historico disponible.</p>';
}

async function openProductModal(product) {
  const modal = document.getElementById('productModal');
  const image = document.getElementById('modalImage');

  document.getElementById('modalName').textContent = product.nombre;
  document.getElementById('modalFormat').textContent = product.formato || '';
  image.src = product.imagen_url || '';
  image.style.display = product.imagen_url ? 'block' : 'none';
  image.onerror = function onError() {
    this.style.display = 'none';
  };
  document.getElementById('modalLink').href = product.url || '#';

  if (product.latestPrice) {
    document.getElementById('modalPrice').textContent = formatPrice(product.latestPrice.precio);
    document.getElementById('modalPriceRef').textContent = product.latestPrice.precio_referencia
      ? `${formatPrice(product.latestPrice.precio_referencia)}/kg`
      : '';
  } else {
    document.getElementById('modalPrice').textContent = '—';
    document.getElementById('modalPriceRef').textContent = '';
  }

  modal.classList.remove('hidden');

  if (product.priceHistory?.length) {
    createChart('chartProductHistory', {
      type: 'line',
      data: {
        labels: product.priceHistory.map((entry) => formatIsoDate(entry.fecha, 'tiny')),
        datasets: [
          {
            data: product.priceHistory.map((entry) => entry.precio),
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.12)',
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: '#6366f1',
            pointBorderWidth: 2,
            pointBorderColor: '#0f172a',
            borderWidth: 2.5,
          },
        ],
      },
      options: {
        ...getBaseChartOptions(),
        plugins: {
          ...getBaseChartOptions().plugins,
          tooltip: {
            ...getTooltipStyle(),
            callbacks: {
              label: (context) => formatPrice(context.parsed.y),
            },
          },
        },
        scales: {
          x: getCategoryAxisStyle(),
          y: {
            ...getValueAxisStyle(),
            ticks: {
              ...getValueAxisStyle().ticks,
              callback: (value) => formatPrice(value),
            },
          },
        },
      },
    });
  }
}

function openProductById(productId, fallbackUrl = '') {
  const product = productById.get(productId);
  if (product) {
    openProductModal(product);
    return;
  }

  if (fallbackUrl) {
    window.open(fallbackUrl, '_blank', 'noopener');
  }
}

function createProductCard(product) {
  let changeMarkup = '';

  if (product.priceHistory.length >= 2) {
    const first = product.priceHistory[0].precio;
    const last = product.priceHistory[product.priceHistory.length - 1].precio;
    if (first > 0) {
      const change = ((last - first) / first) * 100;
      if (Math.abs(change) > 0.01) {
        const changeClass = change > 0 ? 'up' : 'down';
        changeMarkup = `<span class="price-change ${changeClass}">${formatSignedPercent(change, 1)}</span>`;
      }
    }
  }

  return `
    <article class="product-card" data-id="${product.id}">
      <img src="${product.imagen_url || ''}" alt="${escapeHtml(product.nombre)}" onerror="this.style.display='none'" loading="lazy" />
      <div class="product-card-info">
        <div class="product-card-name">${escapeHtml(product.nombre)}</div>
        <div class="product-card-format">${escapeHtml(product.formato || '')}</div>
        <div class="product-card-price">
          <span class="price-main">${product.latestPrice ? formatPrice(product.latestPrice.precio) : '—'}</span>
          ${changeMarkup}
        </div>
      </div>
    </article>
  `;
}

function createRecentProductCard(product) {
  const summary = getProductChangeSummary(product);
  const badge = summary && Math.abs(summary.change) > 0.01
    ? `<span class="recent-product-badge ${summary.change > 0 ? 'up' : 'down'}">${formatSignedPercent(summary.change, 1)}</span>`
    : '';

  return `
    <article class="recent-product-card" data-id="${product.id}">
      <div class="recent-product-media">
        <img src="${product.imagen_url || ''}" alt="${escapeHtml(product.nombre)}" onerror="this.style.display='none'" loading="lazy" />
      </div>
      <div class="recent-product-body">
        <div class="recent-product-name">${escapeHtml(product.nombre)}</div>
        <div class="recent-product-format">${escapeHtml(product.formato || '')}</div>
        <div class="recent-product-footer">
          <span class="recent-product-price">${product.latestPrice ? formatPrice(product.latestPrice.precio) : '—'}</span>
          ${badge}
        </div>
      </div>
    </article>
  `;
}

function getProductChangeSummary(product) {
  if (!product?.priceHistory || product.priceHistory.length < 2) return null;

  const first = product.priceHistory[0].precio;
  const last = product.priceHistory[product.priceHistory.length - 1].precio;
  if (!first || !last) return null;

  return {
    change: ((last - first) / first) * 100,
  };
}

function renderProductGrid(containerId, products) {
  const container = document.getElementById(containerId);
  if (!products.length) {
    container.innerHTML = '<p class="empty-state">No hay productos para mostrar.</p>';
    return;
  }

  container.innerHTML = products.map((product) => createProductCard(product)).join('');
  attachProductCardListeners(container);
}

function attachProductCardListeners(container) {
  container.querySelectorAll('.product-card[data-id]').forEach((card) => {
    card.addEventListener('click', () => openProductById(Number(card.dataset.id)));
  });
}

function attachRecentProductCardListeners(container) {
  container.querySelectorAll('.recent-product-card[data-id]').forEach((card) => {
    card.addEventListener('click', () => openProductById(Number(card.dataset.id)));
  });
}

function createChart(canvasId, config) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  chartInstances[canvasId] = new Chart(canvas, config);
  return chartInstances[canvasId];
}

function destroyChart(canvasId) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
    delete chartInstances[canvasId];
  }
}

function getBaseChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 450,
    },
    layout: {
      padding: {
        top: 10,
        right: 12,
        bottom: 10,
        left: 12,
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: getTooltipStyle(),
    },
    interaction: {
      mode: 'nearest',
      intersect: false,
    },
  };
}

function getTooltipStyle() {
  return {
    backgroundColor: '#0f172a',
    titleColor: '#f8fafc',
    bodyColor: '#cbd5e1',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    cornerRadius: 10,
    padding: 14,
    titleFont: {
      size: 13,
      weight: '700',
    },
    bodyFont: {
      size: 12,
    },
  };
}

function getCategoryAxisStyle() {
  return {
    grid: {
      color: 'rgba(255,255,255,0.04)',
      drawBorder: false,
    },
    ticks: {
      color: '#94a3b8',
      font: { size: 12, weight: '500' },
      padding: 8,
    },
  };
}

function getValueAxisStyle() {
  return {
    grid: {
      color: 'rgba(255,255,255,0.05)',
      drawBorder: false,
    },
    ticks: {
      color: '#94a3b8',
      font: { size: 12, weight: '500' },
      padding: 8,
    },
  };
}

function getLegendStyle() {
  return {
    display: true,
    labels: {
      color: '#cbd5e1',
      usePointStyle: true,
      boxWidth: 10,
      padding: 14,
      font: {
        size: 12,
        weight: '600',
      },
    },
  };
}

function getHeatmapColor(value) {
  const intensity = Math.min(Math.abs(value) / 8, 1);
  if (value > 0.01) {
    return {
      background: `rgba(239, 68, 68, ${0.14 + intensity * 0.46})`,
      border: `rgba(248, 113, 113, ${0.2 + intensity * 0.5})`,
    };
  }
  if (value < -0.01) {
    return {
      background: `rgba(34, 197, 94, ${0.14 + intensity * 0.46})`,
      border: `rgba(74, 222, 128, ${0.2 + intensity * 0.5})`,
    };
  }
  return {
    background: 'rgba(148, 163, 184, 0.1)',
    border: 'rgba(148, 163, 184, 0.16)',
  };
}

function formatPrice(value) {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-ES', {
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatIndex(value) {
  return Number(value || 0).toLocaleString('es-ES', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

function formatPercent(value, digits = 2) {
  return `${Number(value || 0).toLocaleString('es-ES', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function formatSignedPercent(value, digits = 2) {
  const number = Number(value || 0);
  const sign = number > 0 ? '+' : '';
  return `${sign}${formatPercent(number, digits)}`;
}

function formatCompactSignedPercent(value) {
  const digits = Math.abs(value) >= 10 ? 0 : 1;
  return formatSignedPercent(value, digits);
}

function formatSignedNumber(value, digits = 2) {
  const number = Number(value || 0);
  const sign = number > 0 ? '+' : '';
  return `${sign}${number.toLocaleString('es-ES', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatIsoDate(isoDate, style = 'tiny') {
  if (!isoDate) return '-';
  const [year, month, day] = isoDate.split('-').map(Number);
  if (style === 'monthYear') return `${capitalize(MONTHS_LONG[month - 1])} ${year}`;
  if (style === 'long') return `${String(day).padStart(2, '0')} ${MONTHS_SHORT[month - 1]} ${year}`;
  return `${String(day).padStart(2, '0')} ${MONTHS_SHORT[month - 1]}`;
}

function truncate(value, maxLength) {
  if (!value) return '';
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function wrapLabel(value, lineLength = 20, maxLines = 2) {
  const text = String(value || '').trim();
  if (!text) return [''];
  if (text.length <= lineLength) return [text];

  const words = text.split(/\s+/);
  const lines = [];
  let current = '';

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= lineLength) {
      current = candidate;
      return;
    }

    if (current) lines.push(current);
    current = word;
  });

  if (current) lines.push(current);

  const limited = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    const lastIndex = limited.length - 1;
    limited[lastIndex] = `${truncate(limited[lastIndex], Math.max(8, lineLength - 3))}`;
  }

  return limited;
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
