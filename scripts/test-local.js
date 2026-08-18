/**
 * Local test: send a fake Shopify-shaped rate request to the running middleware.
 *
 * First: `npm start` in one terminal.
 * Then: `npm run test-rate` in another.
 */
const payload = {
  rate: {
    origin: {
      country: 'GT',
      postal_code: '01001',
      province: 'Guatemala',
      province_code: 'GT-GU',
      city: 'Guatemala',
      address1: 'Zona 10',
    },
    destination: {
      country: 'GT',
      postal_code: '09001',
      province: 'Quetzaltenango',
      province_code: 'GT-QZ',
      city: 'Quetzaltenango',
      address1: 'Calle 5',
    },
    items: [
      {
        name: 'Sofá Azul Ashley',
        sku: 'SOFA-001',
        quantity: 1,
        grams: 25000, // 25 kg
        price: 499900, // Q4999 in cents
        vendor: 'Ashley',
        requires_shipping: true,
      },
    ],
    currency: 'GTQ',
    locale: 'es-GT',
  },
};

const url = process.argv[2] || 'http://localhost:3000/test/rates';

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
  .then((r) => r.json())
  .then((data) => {
    console.log('\n=== Response from middleware ===');
    console.log(JSON.stringify(data, null, 2));
    console.log('\nPrices are in cents. Divide by 100 for display value.\n');
  })
  .catch((err) => {
    console.error('Request failed:', err.message);
    console.error('Is the server running? Try `npm start` first.');
    process.exit(1);
  });
