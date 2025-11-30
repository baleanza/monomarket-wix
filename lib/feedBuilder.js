import { create } from 'xmlbuilder2';
import {
  escapeXml,
  convertUnits,
  processTagParamValue
} from './helpers.js';

const CORE_TAGS = [
  'id',
  'code',
  'vendor_code',
  'title',
  'barcode',
  'category',
  'category_id',
  'brand',
  'availability',
  'weight',
  'height',
  'width',
  'length',
  'description'
];

export function buildOffersXml(importValues, controlValues) {
  if (!importValues || importValues.length === 0) {
    const rootEmpty = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('Market')
      .ele('offers')
      .up()
      .up();
    return rootEmpty.end({ prettyPrint: true, headless: false });
  }

  const headers = importValues[0] || [];
  const rows = importValues.slice(1);

  const controlHeaders = controlValues[0] || [];
  const controlRows = controlValues.slice(1);

  // ожидаем заголовки:
  // A: Import field
  // B: Enabled
  // C: Feed name
  // D: Tag name
  // E: Units
  const idxImportField = controlHeaders.indexOf('Import field');
  const idxEnabled = controlHeaders.indexOf('Enabled');
  const idxFeedName = controlHeaders.indexOf('Feed name');
  const idxTagName = controlHeaders.indexOf('Tag name');
  const idxUnits = controlHeaders.indexOf('Units');

  const controlMap = {};
  controlRows.forEach((row) => {
    const importField = row[idxImportField] || '';
    if (!importField) return;

    let enabledRaw = row[idxEnabled];
    let enabled = true;
    if (enabledRaw != null) {
      const v = String(enabledRaw).trim().toLowerCase();
      enabled = !['false', '0', 'no', 'ні'].includes(v);
    }

    const xmlName = row[idxFeedName] || '';
    const tagName = idxTagName >= 0 ? (row[idxTagName] || '') : '';
    const units = idxUnits >= 0 ? (row[idxUnits] || '') : '';

    controlMap[importField] = {
      enabled,
      xmlName,
      tagName,
      units
    };
  });

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('Market')
    .ele('offers');

  rows.forEach((row) => {
    const isEmpty = row.join('').trim() === '';
    if (isEmpty) return;

    const offerData = {};
    const imageFields = [];
    const paramTags = [];

    headers.forEach((header, colIndex) => {
      if (!header) return;

      const control = controlMap[header];
      if (!control || !control.enabled) return;

      const { xmlName, tagName, units } = control;
      const cellValue = row[colIndex];

      if (cellValue === 'CellImage') return;
      if (cellValue == null || cellValue === '') return;

      // Картинки
      if (xmlName && xmlName.startsWith('image_')) {
        imageFields.push(String(cellValue));
        return;
      }

      // Теги (param)
      if (xmlName === 'tags') {
        // как в старом коде: если Tag name есть — используем его, иначе — заголовок колонки
        const paramName = (tagName && String(tagName).trim()) || String(header).trim();
        const paramList = processTagParamValue(paramName, cellValue);
        paramTags.push(...paramList);
        return;
      }

      const fieldName = xmlName;
      if (!fieldName) return;

      const isPhysical =
        ['height', 'width', 'length', 'weight'].includes(fieldName);

      if (isPhysical) {
        const converted = convertUnits(fieldName, cellValue, units);
        if (converted != null) {
          offerData[fieldName] = converted;
        }
      } else {
        let value = cellValue;
        if (units && !isPhysical) {
          value = `${cellValue} ${units}`;
        }
        offerData[fieldName] = value;
      }
    });

    const offer = doc.ele('offer');

    // строгий порядок: code, title, id, vendor_code
    const orderedCore = ['code', 'title', 'id', 'vendor_code'];

    orderedCore.forEach((tag) => {
      if (offerData[tag] != null) {
        if (tag === 'description') {
          offer.ele(tag).dat(String(offerData[tag])).up();
        } else {
          offer.ele(tag).txt(String(offerData[tag])).up();
        }
        delete offerData[tag];
      }
    });

    // остальные core-теги
    CORE_TAGS.forEach((tag) => {
      if (orderedCore.includes(tag)) return;
      const value = offerData[tag];
      if (value == null) return;

      if (tag === 'description') {
        offer.ele(tag).dat(String(value)).up();
      } else {
        offer.ele(tag).txt(String(value)).up();
      }
      delete offerData[tag];
    });

    // все остальные поля (некоревые) как простые теги
    Object.entries(offerData).forEach(([tag, value]) => {
      if (value == null) return;
      if (tag === 'description') {
        offer.ele(tag).dat(String(value)).up();
      } else {
        offer.ele(tag).txt(String(value)).up();
      }
    });

    // блок изображений
    if (imageFields.length > 0) {
      const imageLink = offer.ele('image_link');
      imageFields.forEach((url) => {
        imageLink.ele('picture').txt(String(url)).up();
      });
      imageLink.up();
    }

    // блок tags/param
    if (paramTags.length > 0) {
      const tagsNode = offer.ele('tags');
      paramTags.forEach((param) => {
        tagsNode
          .ele('param', { name: param.name })
          .txt(String(param.value))
          .up();
      });
      tagsNode.up();
    }

    offer.up();
  });

  const xml = doc.end({ prettyPrint: true, headless: false });
  return xml.replace(
    /^<\?xml version="1\.0" encoding="UTF-8"\?>/,
    "<?xml version='1.0' encoding='UTF-8'?>"
  );
}
