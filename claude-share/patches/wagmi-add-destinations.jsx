// Patch for PetrAnto/wagmi — src/App.jsx
// Add these 5 entries to the end of the INITIAL_DESTS array (before the closing ])
// PR #28 review: Dubai removed (already exists at line 92 with id:'dubai')
//
// How to apply:
//   1. Open src/App.jsx
//   2. Find the INITIAL_DESTS array closing bracket ]
//   3. Paste these 5 objects before the ]
//   4. Verify app loads and all destinations appear in the selector

  {
    id: 'el-salvador',
    name: 'El Salvador (Bitcoin-friendly)',
    villa: 1200,
    staff: 400,
    school: 300,
    utilities: 150,
    flightCostARPerson: 800,
    features: { nature: 0.7, city: 0.5, warm: 0.95, security: 0.4, education: 0.4 },
    language: { en: 0.3, fr: 0.0, es: 0.95 },
    rentLinks: [
      'https://www.realtor.com/international/sv/',
      'https://www.point2homes.com/MX/Real-Estate-Listings/El-Salvador.html'
    ],
    notes: 'First country to adopt Bitcoin as legal tender. Low cost of living, tropical climate. Growing expat community in El Zonte (Bitcoin Beach) and San Salvador.',
    taxHint: 'Territorial tax system — foreign-sourced income is tax-free. No capital gains tax on Bitcoin. Residency via $1M Bitcoin investment or $52K/yr income proof.'
  },
  {
    id: 'zurich',
    name: 'Zurich (Switzerland)',
    villa: 5500,
    staff: 3000,
    school: 2500,
    utilities: 400,
    flightCostARPerson: 1200,
    features: { nature: 0.95, city: 0.9, warm: 0.3, security: 0.95, education: 0.95 },
    language: { en: 0.7, fr: 0.3, es: 0.05 },
    rentLinks: [
      'https://www.homegate.ch/en',
      'https://www.immoscout24.ch/en'
    ],
    notes: 'One of the highest quality-of-life cities globally. Excellent public transport, healthcare, and international schools. Very expensive but world-class infrastructure.',
    taxHint: 'Lump-sum taxation (forfait fiscal) available for non-working foreigners — negotiate a fixed annual tax instead of income-based. Canton Zug nearby has lowest corporate tax in Switzerland (~12%).'
  },
  {
    id: 'tallinn',
    name: 'Tallinn (Estonia)',
    villa: 1800,
    staff: 800,
    school: 600,
    utilities: 250,
    flightCostARPerson: 900,
    features: { nature: 0.7, city: 0.75, warm: 0.2, security: 0.85, education: 0.8 },
    language: { en: 0.7, fr: 0.05, es: 0.05 },
    rentLinks: [
      'https://www.city24.ee/en',
      'https://kv.ee/?lang=en'
    ],
    notes: 'Digital nomad pioneer — e-Residency program, paperless government. Fast internet, vibrant startup scene. Cold winters but beautiful old town and coastline.',
    taxHint: 'e-Residency allows EU company formation remotely. 0% corporate tax on reinvested profits (20% on distributions). Flat 20% personal income tax. No tax on undistributed company profits.'
  },
  {
    id: 'mexico-city',
    name: 'Mexico City',
    villa: 1500,
    staff: 500,
    school: 500,
    utilities: 100,
    flightCostARPerson: 500,
    features: { nature: 0.5, city: 0.95, warm: 0.7, security: 0.5, education: 0.65 },
    language: { en: 0.4, fr: 0.05, es: 1.0 },
    rentLinks: [
      'https://www.inmuebles24.com/',
      'https://www.metroscubicos.com/'
    ],
    notes: 'Massive cultural capital with world-class food, art, and nightlife. Roma/Condesa/Polanco neighborhoods popular with expats. Very affordable compared to US/EU cities. High altitude keeps temperatures mild year-round.',
    taxHint: 'Territorial tax system for temporary residents — foreign-sourced income not taxed if you qualify. Permanent residents taxed on worldwide income (progressive up to 35%). RESICO simplified regime for small earners.'
  },
  {
    id: 'panama',
    name: 'Panama (Panama City)',
    villa: 2000,
    staff: 600,
    school: 700,
    utilities: 200,
    flightCostARPerson: 600,
    features: { nature: 0.75, city: 0.7, warm: 0.9, security: 0.6, education: 0.6 },
    language: { en: 0.5, fr: 0.05, es: 0.9 },
    rentLinks: [
      'https://www.compreoalquile.com/',
      'https://www.panamarealtor.com/'
    ],
    notes: 'Major financial hub with USD as currency. Pensionado visa is one of the best retirement programs globally. Modern skyline, Canal Zone, tropical climate. Good healthcare infrastructure.',
    taxHint: 'Territorial tax system — only Panama-sourced income is taxed. Foreign income, investments, and capital gains are completely tax-free. Friendly Nations visa for 50+ countries. No estate/inheritance tax.'
  },
