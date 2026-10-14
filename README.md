# Homebridge AristonNet

**Homebridge plugin for Ariston water heaters connected to Ariston NET** (Velis, Lydos, Andris, Slim…).

Exposes the heater as a HomeKit thermostat so you can:

- See the current water temperature
- Set the target temperature
- Turn the heater on / off

Compatible with **Homebridge 1.8+ and Homebridge 2.x**.

## Requirements

- An **Ariston NET** account ([ariston-net.remotethermo.com](https://www.ariston-net.remotethermo.com/)), the same one used by the Ariston mobile app.
- Your **Plant ID**: log in to Ariston NET and copy it from the URL of your device page.

## Installation

Search for `homebridge-aristonnet` in the Homebridge UI **Plugins** tab, or:

```
npm install -g homebridge-aristonnet
```

Then configure it from the plugin **Settings** in the Homebridge UI.

## Configuration

```json
"accessories": [
  {
    "accessory": "AristonWaterHeater",
    "name": "Water Heater",
    "username": "email@gmail.com",
    "password": "your_password",
    "plantId": "your_plant_id",
    "model": "VELIS Tech Dry",
    "serial_number": "123456789",
    "minTemp": 40,
    "maxTemp": 80,
    "refreshInterval": 300
  }
]
```

| Key | Required | Default | Description |
|---|---|---|---|
| `name` | yes | `Ariston Heater` | Name shown in the Home app |
| `username` | yes | | Ariston NET email |
| `password` | yes | | Ariston NET password |
| `plantId` | yes | | Device Plant ID |
| `model` | no | `Unknown Model` | Shown in accessory info |
| `serial_number` | no | `Unknown Serial` | Shown in accessory info |
| `minTemp` | no | `40` | Lowest selectable target temperature (°C) |
| `maxTemp` | no | `80` | Highest selectable target temperature (°C) |
| `refreshInterval` | no | `300` | Background polling interval in seconds (min 60) |

`minTemperature` / `maxTemperature` are still accepted for older configs.

## How it works

- HomeKit requests are answered instantly from a local cache; the cache is refreshed in the background, so the accessory never shows "No Response" because of a slow cloud.
- Changes made in the Home app are applied immediately in HomeKit and sent to Ariston NET after a short debounce (dragging the temperature slider sends a single command). If the command fails, the previous value is restored.
- Login tokens are reused and refreshed automatically; transient errors (timeouts, HTTP 429/5xx) are retried with backoff.
- Credentials are never written to the Homebridge log. Enable Homebridge debug mode for detailed polling logs.

## Changelog

### 2.0.0
- Homebridge 2.0 support (`onGet` / `onSet` API)
- Fixed: the account password could be written to the Homebridge log when a request failed
- Fixed: "No Response" in the Home app while the Ariston cloud was slow
- Fixed: target temperature outside `minTemp`/`maxTemp` caused HomeKit warnings
- Debounced temperature changes, optimistic updates with rollback on failure
- Added `config.schema.json` for configuration from the Homebridge UI
- Removed the unused `requestretry` dependency
