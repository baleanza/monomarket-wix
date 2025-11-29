const { convertLengthToCm, convertWeightToKg } = require('../lib/helpers');

function assertEqual(a,b) { if (a!==b) { console.error('FAIL', a, b); process.exit(1);} }

console.log('running helpers tests...');

// length tests
assertEqual(convertLengthToCm('10,5','мм'), '1.05');
assertEqual(convertLengthToCm('1,2','м'), '120');
assertEqual(convertLengthToCm('15','см'), '15');

// weight tests
assertEqual(convertWeightToKg('1000','г'), '1');
assertEqual(convertWeightToKg('2,5','кг'), '2.5');

console.log('helpers tests passed');
