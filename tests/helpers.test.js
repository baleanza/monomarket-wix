import {
  convertUnits,
  processTagParamValue
} from '../lib/helpers.js';

describe('convertUnits', () => {
  test('10,5 мм -> 1.05 см', () => {
    const result = convertUnits('height', '10,5', 'мм');
    expect(result).toBeCloseTo(1.05);
  });

  test('1,2 м -> 120.00 см', () => {
    const result = convertUnits('length', '1,2', 'м');
    expect(result).toBeCloseTo(120.0);
  });

  test('1000 г -> 1.00 кг', () => {
    const result = convertUnits('weight', '1000', 'г');
    expect(result).toBeCloseTo(1.0);
  });

  test('2.5 кг -> 2.50 кг', () => {
    const result = convertUnits('weight', '2.5', 'кг');
    expect(result).toBeCloseTo(2.5);
  });
});

describe('processTagParamValue', () => {
  test('boolean -> Так/Ні', () => {
    const resTrue = processTagParamValue('Акція', '1');
    const resFalse = processTagParamValue('Акція', '0');
    expect(resTrue).toEqual([{ name: 'Акція', value: 'Так' }]);
    expect(resFalse).toEqual([{ name: 'Акція', value: 'Ні' }]);
  });

  test('Особливості split by comma', () => {
    const res = processTagParamValue('Особливості', 'функція 1, функція 2 ,функція 3');
    expect(res).toEqual([
      { name: 'Особливості', value: 'функція 1' },
      { name: 'Особливості', value: 'функція 2' },
      { name: 'Особливості', value: 'функція 3' }
    ]);
  });
});
