import { buildOffersXml } from '../lib/feedBuilder.js';

describe('buildOffersXml', () => {
  test('order of core tags and presence of image_link/tags', () => {
    const importValues = [
      ['code', 'title', 'id', 'vendor_code', 'height', 'width', 'Особливості', 'Photo1'],
      ['C001', 'Product 1', 'ID1', 'V001', '10', '20', 'функція1,функція2', 'https://img1']
    ];

    const controlValues = [
      ['Import field', 'Enabled', 'Feed name', 'Units'],
      ['code', 'TRUE', 'code', ''],
      ['title', 'TRUE', 'title', ''],
      ['id', 'TRUE', 'id', ''],
      ['vendor_code', 'TRUE', 'vendor_code', ''],
      ['height', 'TRUE', 'height', 'см'],
      ['width', 'TRUE', 'width', 'см'],
      ['Особливості', 'TRUE', 'tags', ''],
      ['Photo1', 'TRUE', 'image_1', '']
    ];

    const xml = buildOffersXml(importValues, controlValues);

    expect(xml).toContain('<offer>');
    expect(xml).toContain('<code>C001</code>');
    expect(xml).toContain('<title>Product 1</title>');
    expect(xml).toContain('<id>ID1</id>');
    expect(xml).toContain('<vendor_code>V001</vendor_code>');
    expect(xml.indexOf('<code>C001</code>')).toBeLessThan(xml.indexOf('<title>Product 1</title>'));
    expect(xml.indexOf('<title>Product 1</title>')).toBeLessThan(xml.indexOf('<id>ID1</id>'));
    expect(xml.indexOf('<id>ID1</id>')).toBeLessThan(xml.indexOf('<vendor_code>V001</vendor_code>'));

    expect(xml).toContain('<height>10</height>');
    expect(xml).toContain('<width>20</width>');

    expect(xml).toContain('<image_link>');
    expect(xml).toContain('<picture>https://img1</picture>');

    expect(xml).toContain('<tags>');
    expect(xml).toContain('<param name="Особливості">функція1</param>');
    expect(xml).toContain('<param name="Особливості">функція2</param>');
  });
});
