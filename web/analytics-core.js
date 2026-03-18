const EPSILON = 1e-9;

export function parseCsvLine(line, delimiter = ';') {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

export function parseNumber(value) {
  if (value == null) return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function round(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

function intersectSets(sets) {
  return sets.reduce((current, set, index) => {
    if (index === 0) return new Set(set);
    return new Set([...current].filter((value) => set.has(value)));
  }, new Set());
}

function unionSets(sets) {
  return sets.reduce((current, set) => {
    for (const value of set) {
      current.add(value);
    }
    return current;
  }, new Set());
}

function buildBalancedPanel(snapshots, field) {
  const commonIds = intersectSets(snapshots.map((snapshot) => new Set(snapshot.rows.keys())));
  return [...commonIds].filter((id) =>
    snapshots.every((snapshot) => {
      const value = snapshot.rows.get(id)?.[field];
      return value != null && Number.isFinite(value) && value > 0;
    }),
  );
}

function buildIndexSeries(snapshots, panelIds, field) {
  if (!snapshots.length || !panelIds.length) {
    return snapshots.map((snapshot) => ({
      date: snapshot.date,
      value: 0,
    }));
  }

  const firstSnapshot = snapshots[0];
  const baseTotal = panelIds.reduce(
    (sum, id) => sum + firstSnapshot.rows.get(id)[field],
    0,
  );

  if (!Number.isFinite(baseTotal) || Math.abs(baseTotal) < EPSILON) {
    return snapshots.map((snapshot) => ({
      date: snapshot.date,
      value: 0,
    }));
  }

  return snapshots.map((snapshot) => {
    const total = panelIds.reduce((sum, id) => sum + snapshot.rows.get(id)[field], 0);
    return {
      date: snapshot.date,
      value: round((total / baseTotal) * 100, 3),
    };
  });
}

function compareRows(previousRow, currentRow, field) {
  const previous = previousRow?.[field];
  const current = currentRow?.[field];

  if (previous == null || current == null || !Number.isFinite(previous) || !Number.isFinite(current)) {
    return null;
  }

  return {
    previous,
    current,
    delta: current - previous,
    percentChange: previous > 0 ? ((current - previous) / previous) * 100 : null,
  };
}

function buildDiffusionSummary(commonIds, previousRows, currentRows, field) {
  let upCount = 0;
  let downCount = 0;
  let sameCount = 0;
  let comparableCount = 0;

  for (const id of commonIds) {
    const comparison = compareRows(previousRows.get(id), currentRows.get(id), field);
    if (!comparison) continue;

    comparableCount += 1;

    if (Math.abs(comparison.delta) < EPSILON) {
      sameCount += 1;
    } else if (comparison.delta > 0) {
      upCount += 1;
    } else {
      downCount += 1;
    }
  }

  const changedCount = upCount + downCount;
  return {
    total: comparableCount,
    changedCount,
    changedPct: comparableCount ? round((changedCount / comparableCount) * 100, 3) : 0,
    upCount,
    upPct: comparableCount ? round((upCount / comparableCount) * 100, 3) : 0,
    downCount,
    downPct: comparableCount ? round((downCount / comparableCount) * 100, 3) : 0,
    sameCount,
    samePct: comparableCount ? round((sameCount / comparableCount) * 100, 3) : 0,
  };
}

function calculateMedian(sortedValues) {
  if (!sortedValues.length) return 0;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function buildVariationStats(panelIds, firstRows, lastRows, field) {
  const values = panelIds
    .map((id) => compareRows(firstRows.get(id), lastRows.get(id), field)?.percentChange)
    .filter((value) => value != null)
    .sort((left, right) => left - right);

  if (!values.length) {
    return {
      medianPct: 0,
      meanPct: 0,
      trimmedMeanPct: 0,
      minPct: 0,
      maxPct: 0,
    };
  }

  const trimSize = Math.floor(values.length * 0.1);
  const trimmed = values.slice(trimSize, values.length - trimSize);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const trimmedMean = trimmed.length
    ? trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length
    : 0;

  return {
    medianPct: round(calculateMedian(values), 3),
    meanPct: round(mean, 3),
    trimmedMeanPct: round(trimmedMean, 3),
    minPct: round(values[0], 3),
    maxPct: round(values[values.length - 1], 3),
  };
}

function buildIntervalSeries(snapshots, field) {
  const intervals = [];

  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    const previousIds = new Set(previous.rows.keys());
    const currentIds = new Set(current.rows.keys());
    const commonIds = [...previousIds].filter((id) => currentIds.has(id));
    const summary = buildDiffusionSummary(commonIds, previous.rows, current.rows, field);

    intervals.push({
      from: previous.date,
      to: current.date,
      label: `${previous.date} -> ${current.date}`,
      shortLabel: current.date,
      commonCount: commonIds.length,
      newCount: [...currentIds].filter((id) => !previousIds.has(id)).length,
      disappearedCount: [...previousIds].filter((id) => !currentIds.has(id)).length,
      ...summary,
    });
  }

  return intervals;
}

function buildMovers(commonIds, firstRows, lastRows) {
  const movers = [];

  for (const id of commonIds) {
    const comparison = compareRows(firstRows.get(id), lastRows.get(id), 'price');
    if (!comparison || comparison.percentChange == null) continue;

    const referenceComparison = compareRows(firstRows.get(id), lastRows.get(id), 'referencePrice');
    const meta = lastRows.get(id) || firstRows.get(id);

    movers.push({
      id,
      name: meta.name,
      url: meta.url,
      image: meta.image,
      startPrice: round(comparison.previous, 2),
      endPrice: round(comparison.current, 2),
      delta: round(comparison.delta, 2),
      changePct: round(comparison.percentChange, 2),
      referenceChangePct: referenceComparison?.percentChange != null
        ? round(referenceComparison.percentChange, 2)
        : null,
    });
  }

  return {
    up: movers
      .filter((item) => item.changePct > 0.01)
      .sort((left, right) => right.changePct - left.changePct),
    down: movers
      .filter((item) => item.changePct < -0.01)
      .sort((left, right) => left.changePct - right.changePct),
  };
}

function buildContributionSeries(panelIds, firstRows, lastRows) {
  if (!panelIds.length) {
    return {
      topPositive: [],
      topNegative: [],
      waterfall: [],
      totalContribution: 0,
      selectedCount: 0,
    };
  }

  const baseTotal = panelIds.reduce((sum, id) => sum + firstRows.get(id).price, 0);
  if (!Number.isFinite(baseTotal) || Math.abs(baseTotal) < EPSILON) {
    return {
      topPositive: [],
      topNegative: [],
      waterfall: [],
      totalContribution: 0,
      selectedCount: 0,
    };
  }

  const entries = panelIds
    .map((id) => {
      const comparison = compareRows(firstRows.get(id), lastRows.get(id), 'price');
      const meta = lastRows.get(id) || firstRows.get(id);

      return {
        id,
        name: meta.name,
        url: meta.url,
        image: meta.image,
        delta: round(comparison.delta, 2),
        contributionPct: round((comparison.delta / baseTotal) * 100, 4),
        changePct: round(comparison.percentChange, 2),
      };
    })
    .sort((left, right) => right.contributionPct - left.contributionPct);

  const positives = entries.filter((entry) => entry.contributionPct > 0).slice(0, 6);
  const negatives = [...entries]
    .filter((entry) => entry.contributionPct < 0)
    .sort((left, right) => left.contributionPct - right.contributionPct)
    .slice(0, 6);

  const selectedIds = new Set([...positives, ...negatives].map((entry) => entry.id));
  const totalContribution = round(entries.reduce((sum, entry) => sum + entry.contributionPct, 0), 4);
  const selectedContribution = round(
    [...positives, ...negatives].reduce((sum, entry) => sum + entry.contributionPct, 0),
    4,
  );
  const restContribution = round(totalContribution - selectedContribution, 4);

  const waterfallSegments = [];
  let cumulative = 0;

  for (const entry of [...positives, ...negatives]) {
    waterfallSegments.push({
      label: entry.name,
      shortLabel: entry.name,
      start: round(cumulative, 4),
      end: round(cumulative + entry.contributionPct, 4),
      value: entry.contributionPct,
      type: entry.contributionPct >= 0 ? 'positive' : 'negative',
      id: entry.id,
      url: entry.url,
    });
    cumulative = round(cumulative + entry.contributionPct, 4);
  }

  if (Math.abs(restContribution) > EPSILON) {
    waterfallSegments.push({
      label: 'Resto del surtido',
      shortLabel: 'Resto',
      start: round(cumulative, 4),
      end: round(cumulative + restContribution, 4),
      value: restContribution,
      type: restContribution >= 0 ? 'positive' : 'negative',
    });
    cumulative = round(cumulative + restContribution, 4);
  }

  waterfallSegments.push({
    label: 'Inflacion total',
    shortLabel: 'Total',
    start: 0,
    end: totalContribution,
    value: totalContribution,
    type: 'total',
  });

  return {
    topPositive: positives,
    topNegative: negatives,
    waterfall: waterfallSegments,
    totalContribution,
    selectedCount: selectedIds.size,
  };
}

function buildHistogram(values, binCount = 25) {
  if (!values.length) {
    return {
      min: -10,
      max: 10,
      binSize: 0.8,
      bins: Array.from({ length: binCount }, (_, index) => ({
        start: round(-10 + index * 0.8, 3),
        end: round(-10 + (index + 1) * 0.8, 3),
        label: `${round(-10 + index * 0.8, 1)} a ${round(-10 + (index + 1) * 0.8, 1)}`,
        count: 0,
      })),
    };
  }

  const maxAbs = Math.max(
    ...values.map((value) => Math.abs(value)),
    10,
  );
  const cap = Math.ceil(maxAbs / 5) * 5;
  const min = -cap;
  const max = cap;
  const binSize = (max - min) / binCount;

  const bins = Array.from({ length: binCount }, (_, index) => {
    const start = round(min + index * binSize, 3);
    const end = round(start + binSize, 3);
    return {
      start,
      end,
      label: `${round(start, 1)} a ${round(end, 1)}`,
      count: 0,
    };
  });

  for (const value of values) {
    const bounded = Math.min(Math.max(value, min), max - EPSILON);
    const index = Math.min(
      Math.floor((bounded - min) / binSize),
      bins.length - 1,
    );
    bins[index].count += 1;
  }

  return {
    min,
    max,
    binSize: round(binSize, 3),
    bins,
  };
}

function buildScatterData(panelIds, firstRows, lastRows) {
  return panelIds
    .map((id) => {
      const priceChange = compareRows(firstRows.get(id), lastRows.get(id), 'price')?.percentChange;
      const referenceChange = compareRows(firstRows.get(id), lastRows.get(id), 'referencePrice')?.percentChange;
      const meta = lastRows.get(id) || firstRows.get(id);

      if (priceChange == null || referenceChange == null) {
        return null;
      }

      return {
        x: round(priceChange, 3),
        y: round(referenceChange, 3),
        id,
        name: meta.name,
        url: meta.url,
      };
    })
    .filter(Boolean);
}

function buildHeatmap(snapshots, panelIds) {
  if (snapshots.length < 2 || !panelIds.length) {
    return { columns: [], rows: [] };
  }

  const columns = [];
  const rows = panelIds
    .map((id) => {
      let changeCount = 0;
      let absoluteSum = 0;
      const values = [];

      for (let index = 1; index < snapshots.length; index += 1) {
        const previous = snapshots[index - 1];
        const current = snapshots[index];
        const change = compareRows(previous.rows.get(id), current.rows.get(id), 'price')?.percentChange ?? 0;
        const roundedChange = round(change, 2);

        values.push(roundedChange);
        if (Math.abs(roundedChange) > 0.01) {
          changeCount += 1;
          absoluteSum += Math.abs(roundedChange);
        }

        if (id === panelIds[0]) {
          columns.push({
            from: previous.date,
            to: current.date,
            label: `${previous.date} -> ${current.date}`,
            shortLabel: current.date,
          });
        }
      }

      const firstRow = snapshots[0].rows.get(id);
      const lastRow = snapshots[snapshots.length - 1].rows.get(id);
      const totalPct = compareRows(firstRow, lastRow, 'price')?.percentChange ?? 0;
      const meta = lastRow || firstRow;

      return {
        id,
        name: meta.name,
        url: meta.url,
        image: meta.image,
        changeCount,
        totalPct: round(totalPct, 2),
        absoluteSum: round(absoluteSum, 2),
        values,
      };
    })
    .sort((left, right) => {
      if (right.changeCount !== left.changeCount) return right.changeCount - left.changeCount;
      if (right.absoluteSum !== left.absoluteSum) return right.absoluteSum - left.absoluteSum;
      return Math.abs(right.totalPct) - Math.abs(left.totalPct);
    })
    .slice(0, 24);

  return { columns, rows };
}

export function buildAnalyticsFromSnapshots(rawSnapshots) {
  const snapshots = [...rawSnapshots]
    .filter((snapshot) => snapshot?.date && snapshot?.rows instanceof Map && snapshot.rows.size)
    .sort((left, right) => left.date.localeCompare(right.date));

  if (!snapshots.length) {
    throw new Error('No hay snapshots suficientes para construir la analitica.');
  }

  const snapshotSets = snapshots.map((snapshot) => new Set(snapshot.rows.keys()));
  const allDatesCommonIds = intersectSets(snapshotSets);
  const allDatesUnionIds = unionSets(snapshotSets);
  const firstSnapshot = snapshots[0];
  const lastSnapshot = snapshots[snapshots.length - 1];
  const firstLastCommonIds = new Set(
    [...firstSnapshot.rows.keys()].filter((id) => lastSnapshot.rows.has(id)),
  );
  const firstLastDiffusion = buildDiffusionSummary(
    [...firstLastCommonIds],
    firstSnapshot.rows,
    lastSnapshot.rows,
    'price',
  );

  const pricePanelIds = buildBalancedPanel(snapshots, 'price');
  const referencePanelIds = buildBalancedPanel(snapshots, 'referencePrice');
  const priceIndexSeries = buildIndexSeries(snapshots, pricePanelIds, 'price');
  const referenceIndexSeries = buildIndexSeries(snapshots, referencePanelIds, 'referencePrice');
  const intervalSeries = buildIntervalSeries(snapshots, 'price');
  const movers = buildMovers([...firstLastCommonIds], firstSnapshot.rows, lastSnapshot.rows);
  const contribution = buildContributionSeries(pricePanelIds, firstSnapshot.rows, lastSnapshot.rows);

  const priceVariations = pricePanelIds
    .map((id) => compareRows(firstSnapshot.rows.get(id), lastSnapshot.rows.get(id), 'price')?.percentChange)
    .filter((value) => value != null);
  const referenceVariations = referencePanelIds
    .map((id) =>
      compareRows(firstSnapshot.rows.get(id), lastSnapshot.rows.get(id), 'referencePrice')?.percentChange,
    )
    .filter((value) => value != null);

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      snapshotCount: snapshots.length,
      range: {
        start: firstSnapshot.date,
        end: lastSnapshot.date,
      },
      sourceFiles: snapshots.map((snapshot) => snapshot.filename || snapshot.date),
      countsByDate: snapshots.map((snapshot) => ({
        date: snapshot.date,
        count: snapshot.count ?? snapshot.rows.size,
      })),
      firstCount: firstSnapshot.count ?? firstSnapshot.rows.size,
      lastCount: lastSnapshot.count ?? lastSnapshot.rows.size,
      unionSize: allDatesUnionIds.size,
      commonAllDates: allDatesCommonIds.size,
      commonFirstLast: firstLastCommonIds.size,
      pricePanelSize: pricePanelIds.length,
      referencePanelSize: referencePanelIds.length,
    },
    kpis: {
      fixedBasketIndex: {
        current: priceIndexSeries[priceIndexSeries.length - 1]?.value ?? 0,
        changePct: round((priceIndexSeries[priceIndexSeries.length - 1]?.value ?? 0) - 100, 3),
        panelSize: pricePanelIds.length,
      },
      referenceIndex: {
        current: referenceIndexSeries[referenceIndexSeries.length - 1]?.value ?? 0,
        changePct: round((referenceIndexSeries[referenceIndexSeries.length - 1]?.value ?? 0) - 100, 3),
        panelSize: referencePanelIds.length,
      },
      diffusion: firstLastDiffusion,
      rotation: {
        newCount: [...lastSnapshot.rows.keys()].filter((id) => !firstSnapshot.rows.has(id)).length,
        disappearedCount: [...firstSnapshot.rows.keys()].filter((id) => !lastSnapshot.rows.has(id)).length,
        netCount:
          [...lastSnapshot.rows.keys()].filter((id) => !firstSnapshot.rows.has(id)).length
          - [...firstSnapshot.rows.keys()].filter((id) => !lastSnapshot.rows.has(id)).length,
      },
      robustPrice: buildVariationStats(pricePanelIds, firstSnapshot.rows, lastSnapshot.rows, 'price'),
      robustReference: buildVariationStats(
        referencePanelIds,
        firstSnapshot.rows,
        lastSnapshot.rows,
        'referencePrice',
      ),
      lastInterval: intervalSeries[intervalSeries.length - 1] ?? {
        from: firstSnapshot.date,
        to: lastSnapshot.date,
        changedCount: 0,
        changedPct: 0,
        upCount: 0,
        downCount: 0,
        sameCount: 0,
        total: 0,
      },
    },
    series: {
      fixedBasketIndex: priceIndexSeries,
      referenceIndex: referenceIndexSeries,
      snapshotCounts: snapshots.map((snapshot) => ({
        date: snapshot.date,
        value: snapshot.count ?? snapshot.rows.size,
      })),
      intervalDiffusion: intervalSeries.map((interval) => ({
        from: interval.from,
        to: interval.to,
        label: interval.label,
        shortLabel: interval.shortLabel,
        total: interval.total,
        changedCount: interval.changedCount,
        changedPct: interval.changedPct,
        upCount: interval.upCount,
        upPct: interval.upPct,
        downCount: interval.downCount,
        downPct: interval.downPct,
        sameCount: interval.sameCount,
        samePct: interval.samePct,
      })),
      intervalRotation: intervalSeries.map((interval) => ({
        from: interval.from,
        to: interval.to,
        label: interval.label,
        shortLabel: interval.shortLabel,
        commonCount: interval.commonCount,
        newCount: interval.newCount,
        disappearedCount: interval.disappearedCount,
      })),
      histogramPrice: buildHistogram(priceVariations),
      histogramReference: buildHistogram(referenceVariations),
      scatterPriceVsReference: buildScatterData(referencePanelIds, firstSnapshot.rows, lastSnapshot.rows),
      topMoversUp: movers.up.slice(0, 12),
      topMoversDown: movers.down.slice(0, 12),
      contributionWaterfall: contribution.waterfall,
      topContributorsUp: contribution.topPositive,
      topContributorsDown: contribution.topNegative,
      heatmap: buildHeatmap(snapshots, pricePanelIds),
    },
  };
}

export function buildSnapshotsFromProducts(products) {
  const snapshotsByDate = new Map();

  for (const product of products || []) {
    const history = Array.isArray(product?.priceHistory) ? product.priceHistory : [];

    for (const entry of history) {
      const date = String(entry?.fecha || '').trim();
      if (!date) continue;

      if (!snapshotsByDate.has(date)) {
        snapshotsByDate.set(date, {
          date,
          filename: `supabase:${date}`,
          rows: new Map(),
        });
      }

      snapshotsByDate.get(date).rows.set(Number(product.id), {
        id: Number(product.id),
        name: String(product.nombre || '').trim(),
        format: String(product.formato || '').trim(),
        price: parseNumber(entry.precio),
        referencePrice: parseNumber(entry.precio_referencia),
        url: String(product.url || '').trim(),
        image: String(product.imagen_url || '').trim(),
        weighted: Boolean(product.es_pesado),
      });
    }
  }

  return [...snapshotsByDate.values()]
    .map((snapshot) => ({
      ...snapshot,
      count: snapshot.rows.size,
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function buildAnalyticsFromProducts(products) {
  return buildAnalyticsFromSnapshots(buildSnapshotsFromProducts(products));
}
