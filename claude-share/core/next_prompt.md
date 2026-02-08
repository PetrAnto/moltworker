# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-08

---

## Current Task: Phase 2.5.3 — Weather Tool (Open-Meteo)

### Requirements

You are working on Moltworker, a multi-platform AI assistant gateway on Cloudflare Workers.

Add a new `get_weather` tool that fetches current weather conditions and a 7-day forecast using the free Open-Meteo API. No API key needed, no rate limits. This feeds into the future daily briefing aggregator (Phase 2.5.7).

### API

- **Endpoint:** `https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto`
- **Auth:** None required (completely free, no rate limits)
- **Response:** JSON with `current_weather` (temperature, windspeed, weathercode) and `daily` arrays

### Files to modify

1. **`src/openrouter/tools.ts`** — Add `get_weather` tool definition and execution handler
   - Tool schema: `{ name: "get_weather", parameters: { latitude: string, longitude: string } }`
   - Returns formatted weather summary (current conditions + 7-day forecast)
   - Validate lat/lon ranges (-90 to 90, -180 to 180)
   - Map WMO weather codes to human-readable descriptions

### Implementation

```typescript
// Tool definition
{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather and 7-day forecast for a location. Provide latitude and longitude coordinates.',
    parameters: {
      type: 'object',
      properties: {
        latitude: { type: 'string', description: 'Latitude (-90 to 90)' },
        longitude: { type: 'string', description: 'Longitude (-180 to 180)' }
      },
      required: ['latitude', 'longitude']
    }
  }
}

// WMO Weather Code mapping (subset)
const WMO_CODES: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
};

// Execution
async function getWeather(latitude: string, longitude: string): Promise<string> {
  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  if (isNaN(lat) || lat < -90 || lat > 90) throw new Error('Invalid latitude');
  if (isNaN(lon) || lon < -180 || lon > 180) throw new Error('Invalid longitude');

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo API error: HTTP ${response.status}`);
  const data = await response.json();

  // Format current weather + 7-day forecast
  const current = data.current_weather;
  let output = `Current: ${WMO_CODES[current.weathercode] || 'Unknown'}, ${current.temperature}°C, wind ${current.windspeed} km/h\n\nForecast:\n`;
  for (let i = 0; i < data.daily.time.length; i++) {
    output += `${data.daily.time[i]}: ${data.daily.temperature_2m_min[i]}–${data.daily.temperature_2m_max[i]}°C, ${WMO_CODES[data.daily.weathercode[i]] || 'Unknown'}\n`;
  }
  return output;
}
```

### Success Criteria

- [ ] New `get_weather` tool appears in tool definitions
- [ ] Tool returns formatted current weather + 7-day forecast
- [ ] Validates latitude/longitude ranges
- [ ] Maps WMO weather codes to descriptions
- [ ] Handles errors gracefully (invalid coords, API failure)
- [ ] Test file: `src/openrouter/tools.test.ts` (extend existing)
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes (pre-existing errors OK)

### Key Files
- `src/openrouter/tools.ts` — Tool definitions and execution

---

## Queue After This Task

| Priority | Task | Effort |
|----------|------|--------|
| Next | 2.5.5: News feeds (HN + Reddit + arXiv) | 3h |
| Then | 1.3: Configurable reasoning per model | Medium |
| Then | 2.5.7: Daily briefing aggregator | 6h |

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-08 | Phase 2.5.2: Chart image generation (QuickChart) | Claude Opus 4.6 | 01Wjud3VHKMfSRbvMTzFohGS |
| 2026-02-08 | Phase 2.5.1: URL metadata tool (Microlink) | Claude Opus 4.6 | 01Wjud3VHKMfSRbvMTzFohGS |
| 2026-02-08 | Phase 1.1: Parallel tool execution | Claude Opus 4.6 | 01Lg3st5TTU3gXnMqPxfCPpW |
| 2026-02-08 | Phase 1.2: Model capability metadata | Claude Opus 4.6 | 01Lg3st5TTU3gXnMqPxfCPpW |
| 2026-02-08 | Phase 1.5: Upstream sync (7 cherry-picks) | Claude Opus 4.6 | 01Lg3st5TTU3gXnMqPxfCPpW |
| 2026-02-08 | Free APIs integration analysis + doc updates | Claude Opus 4.6 | 01Lg3st5TTU3gXnMqPxfCPpW |
| 2026-02-07 | Phase 0: Add Pony Alpha, GPT-OSS-120B, GLM 4.7 | Claude Opus 4.6 | 011qMKSadt2zPFgn2GdTTyxH |
| 2026-02-06 | Tool-calling landscape analysis | Claude Opus 4.6 | 011qMKSadt2zPFgn2GdTTyxH |
