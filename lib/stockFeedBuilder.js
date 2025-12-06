import { create } from 'xmlbuilder2';

// ожидание той же шапки Feed Control List:
// A: Import field
// B: Offer feed
// C: Stock feed
// D: Feed name
// E: Tag name
// F: Units
export async function buildStockXml(importValues, controlValues, getInventoryBySkus) {
  if (!importValues || importValues.length === 0) {
    const rootEmpty = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('Stock')
      .ele('offers')
      .up()
      .up();
    return rootEmpty.end({ prettyPrint: true, headless: false });
  }

  const headers = importValues[0] || [];
  const rows = importValues.slice(1);

  const controlHeaders = controlValues[0] || [];
  const controlRows = controlValues.slice(1);

  const idxImportField = controlHeaders.indexOf('Import field');
  const idxStock = controlHeaders.indexOf('Stock feed');
  const idxFeedName = controlHeaders.indexOf('Feed name');
  const idxUnits = controlHeaders.indexOf('Units');

  const stockControl = {};
  controlRows.forEach((row) => {
    const rawImportField = row[idxImportField];
    const importField =
      rawImportField != null ? String(rawImportField).trim() : '';
    if (!importField) return;

    let stockRaw = row[idxStock];
    let enabled = false;
    if (stockRaw != null) {
      const v = String(stockRaw).trim().toLowerCase();
      enabled = !['false', '0', 'no', 'ні', ''].includes(v);
    }

    const xmlName = row[idxFeedName] || '';
    const units = idxUnits >= 0 ? (row[idxUnits] || '') : '';

    stockControl[importField] = {
      enabled,
      xmlName,
      units
    };
  });

  // 1) собираем из таблицы все SKU, у которых Stock feed включён
  const skuHeaderIndex = headers.indexOf('SKU'); // имя колонки с SKU в Import
  if (skuHeaderIndex === -1) {
    // без SKU сток‑фид не собрать
    const rootEmpty = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('Stock')
      .ele('offers')
      .up()
      .up();
    return rootEmpty.end({ prettyPrint: true, headless: false });
  }

  const skuList = [];
  const rowBySku = {};

  rows.forEach((row) => {
    const isEmpty = row.join('').trim() === '';
    if (isEmpty) return;

    const sku = row[skuHeaderIndex];
    if (!sku) return;

    const skuStr = String(sku).trim();
    if (!skuStr) return;

    skuList.push(skuStr);
    rowBySku[skuStr] = row;
  });

  const uniqueSkus = Array.from(new Set(skuList));

  // 2) тянем инвентарь с Wix
  const inventoryItems = await getInventoryBySkus(uniqueSkus);
  const inventoryBySku = {};
  inventoryItems.forEach((item) => {
    const sku = item.sku || (item.product && item.product.sku);
    if (!sku) return;
    inventoryBySku[String(sku)] = item;
  });

  // 3) собираем XML
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('Stock')
    .ele('offers');

  uniqueSkus.forEach((sku) => {
    const row = rowBySku[sku];
    const inv = inventoryBySku[sku] || {};

    const offerData = {};

    headers.forEach((header, colIndex) => {
      if (!header) return;
      const headerKey = String(header).trim();
      const control = stockControl[headerKey];
      if (!control || !control.enabled) return;

      const { xmlName, units } = control;
      if (!xmlName) return;

      let value = row[colIndex];

      // для цены, гарантии и т.п. берём из таблицы
      if (value == null || value === '') return;

      if (units) {
        value = `${value} ${units}`;
      }

      offerData[xmlName] = value;
    });

    // плюс поля, которые идут из инвентаря Wix
    // пример: availability, quantity
    if (inv.inStock !== undefined) {
      offerData.availability = inv.inStock ? 'in_stock' : 'out_of_stock';
    }
    if (inv.quantity !== undefined) {
      offerData.quantity = inv.quantity;
    }

    if (Object.keys(offerData).length === 0) return;

    const offer = doc.ele('offer');
    Object.entries(offerData).forEach(([tag, value]) => {
      offer.ele(tag).txt(String(value)).up();
    });
    offer.up();
  });

  const xml = doc.end({ prettyPrint: true, headless: false });
  return xml.replace(
    /^<\?xml version="1\.0" encoding="UTF-8"\?>/,
    "<?xml version='1.0' encoding='UTF-8'?>"
  );
}
