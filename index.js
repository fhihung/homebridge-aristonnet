'use strict';

const axios = require('axios');

const PLUGIN_NAME = 'homebridge-aristonnet';
const ACCESSORY_NAME = 'AristonWaterHeater';
const API_BASE = 'https://www.ariston-net.remotethermo.com/api/v2';

const TOKEN_TTL_MS = 55 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MIN_REFRESH_GAP_MS = 15000;
const SET_DEBOUNCE_MS = 1000;
// The Ariston cloud keeps returning the previous value for a while after a command.
const PENDING_GRACE_MS = 60000;

let hap;

module.exports = (api) => {
  hap = api.hap;
  api.registerAccessory(PLUGIN_NAME, ACCESSORY_NAME, AristonWaterHeater);
};

class AristonApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AristonApiError';
    this.status = status;
  }
}

function describeError(error) {
  const status = error.status ?? error.response?.status;
  return status ? `${error.message} (HTTP ${status})` : error.message;
}

class AristonWaterHeater {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    const { Service, Characteristic } = hap;
    this.Characteristic = Characteristic;

    this.name = config.name || 'Ariston Heater';
    this.username = config.username;
    this.password = config.password;
    this.plantId = config.plantId;
    this.model = config.model || 'Unknown Model';
    this.serialNumber = config.serial_number || config.serialNumber || 'Unknown Serial';
    this.minTemp = Number(config.minTemp ?? config.minTemperature ?? 40);
    this.maxTemp = Number(config.maxTemp ?? config.maxTemperature ?? 80);
    this.refreshIntervalMs = Math.max(60, Number(config.refreshInterval ?? 300)) * 1000;

    this.configured = Boolean(this.username && this.password && this.plantId);
    if (!this.configured) {
      this.log.error('Missing "username", "password" or "plantId" in config. Accessory will stay offline.');
    }
    if (this.minTemp >= this.maxTemp) {
      this.log.warn(`minTemp (${this.minTemp}) must be lower than maxTemp (${this.maxTemp}); using 40-80.`);
      this.minTemp = 40;
      this.maxTemp = 80;
    }

    this.http = axios.create({ baseURL: API_BASE, timeout: REQUEST_TIMEOUT_MS });
    this.token = null;
    this.tokenExpiry = 0;
    this.loginPromise = null;
    this.fetchPromise = null;
    this.lastFetchTime = 0;
    this.lastError = null;

    this.state = {
      currentTemp: this.minTemp,
      targetTemp: this.minTemp,
      on: false,
    };
    this.pending = {};
    this.setTimers = {};

    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Ariston')
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber);

    this.heaterService = new Service.Thermostat(this.name);
    this.configureCharacteristics();

    if (this.configured) {
      this.refresh();
      this.refreshTimer = setInterval(() => this.refresh(), this.refreshIntervalMs);
    }
    api.on('shutdown', () => this.shutdown());
  }

  configureCharacteristics() {
    const C = this.Characteristic;
    const service = this.heaterService;

    service.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.read(() => this.state.currentTemp));

    service.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
      .onGet(() => this.read(() => this.clampTarget(this.state.targetTemp)))
      .onSet((value) => this.setTargetTemperature(value));

    service.getCharacteristic(C.CurrentHeatingCoolingState)
      .setProps({ validValues: [C.CurrentHeatingCoolingState.OFF, C.CurrentHeatingCoolingState.HEAT] })
      .onGet(() => this.read(() => this.currentHeatingState()));

    service.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT] })
      .onGet(() => this.read(() => this.targetHeatingState()))
      .onSet((value) => this.setHeatingState(value));

    service.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => C.TemperatureDisplayUnits.CELSIUS);
  }

  // HomeKit marks the accessory "No Response" if a getter takes >10s, so answer from
  // cache immediately and refresh in the background.
  read(getValue) {
    if (!this.configured) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (Date.now() - this.lastFetchTime > MIN_REFRESH_GAP_MS) {
      this.refresh();
    }
    return getValue();
  }

  clampTarget(value) {
    return Math.min(this.maxTemp, Math.max(this.minTemp, Math.round(value)));
  }

  currentHeatingState() {
    const C = this.Characteristic.CurrentHeatingCoolingState;
    return this.state.on ? C.HEAT : C.OFF;
  }

  targetHeatingState() {
    const C = this.Characteristic.TargetHeatingCoolingState;
    return this.state.on ? C.HEAT : C.OFF;
  }

  pushStateToHomeKit() {
    const C = this.Characteristic;
    this.heaterService.updateCharacteristic(C.CurrentTemperature, this.state.currentTemp);
    this.heaterService.updateCharacteristic(C.TargetTemperature, this.clampTarget(this.state.targetTemp));
    this.heaterService.updateCharacteristic(C.CurrentHeatingCoolingState, this.currentHeatingState());
    this.heaterService.updateCharacteristic(C.TargetHeatingCoolingState, this.targetHeatingState());
  }

  // ---------- Ariston cloud ----------

  async login() {
    if (!this.loginPromise) {
      this.loginPromise = (async () => {
        try {
          const { data } = await this.http.post('/accounts/login', {
            usr: this.username,
            pwd: this.password,
            imp: false,
            notTrack: true,
            appInfo: { os: 2, appVer: '5.6.7772.40151', appId: 'com.remotethermo.aristonnet' },
          });
          if (!data?.token) {
            throw new AristonApiError('Login response did not contain a token');
          }
          this.token = data.token;
          this.tokenExpiry = Date.now() + TOKEN_TTL_MS;
          this.log.debug('Logged in to Ariston NET');
        } catch (error) {
          this.token = null;
          throw new AristonApiError(`Login failed: ${describeError(error)}`, error.response?.status);
        } finally {
          this.loginPromise = null;
        }
      })();
    }
    return this.loginPromise;
  }

  async request(method, url, data, attempts = 3) {
    let delay = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        if (!this.token || Date.now() >= this.tokenExpiry) {
          await this.login();
        }
        const response = await this.http.request({
          method,
          url,
          data,
          headers: { 'ar.authToken': this.token, 'Content-Type': 'application/json' },
        });
        return response.data;
      } catch (error) {
        const status = error.status ?? error.response?.status;
        if (status === 401) {
          this.token = null;
        }
        const retryable = !status || status === 401 || status === 429 || status >= 500;
        if (!retryable || attempt >= attempts) {
          throw error instanceof AristonApiError
            ? error
            : new AristonApiError(`${method.toUpperCase()} ${url} failed: ${describeError(error)}`, status);
        }
        this.log.debug(`Request failed (${describeError(error)}), retry ${attempt}/${attempts - 1} in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  refresh() {
    if (!this.fetchPromise) {
      this.fetchPromise = this.fetchDeviceState()
        .catch((error) => {
          if (this.lastError !== error.message) {
            this.log.error(`Could not read heater state: ${error.message}`);
          }
          this.lastError = error.message;
        })
        .finally(() => {
          this.fetchPromise = null;
        });
    }
    return this.fetchPromise;
  }

  async fetchDeviceState() {
    const data = await this.request('get', `/velis/medPlantData/${encodeURIComponent(this.plantId)}`);
    this.lastFetchTime = Date.now();
    if (this.lastError) {
      this.log.info('Connection to Ariston NET restored');
      this.lastError = null;
    }
    this.applyRemoteState(data || {});
    this.pushStateToHomeKit();
    this.log.debug(`State: ${this.state.on ? 'ON' : 'OFF'}, current ${this.state.currentTemp}°C, target ${this.state.targetTemp}°C`);
  }

  applyRemoteState(data) {
    const remote = {
      currentTemp: typeof data.temp === 'number' ? data.temp : undefined,
      targetTemp: typeof data.procReqTemp === 'number' ? data.procReqTemp
        : typeof data.reqTemp === 'number' ? data.reqTemp : undefined,
      on: typeof data.on === 'boolean' ? data.on : undefined,
    };
    for (const [key, value] of Object.entries(remote)) {
      if (value === undefined) {
        continue;
      }
      const pending = this.pending[key];
      if (pending && Date.now() < pending.until && value !== pending.value) {
        continue;
      }
      delete this.pending[key];
      this.state[key] = value;
    }
  }

  // ---------- Commands ----------

  setTargetTemperature(value) {
    const target = this.clampTarget(value);
    const previous = this.state.targetTemp;
    this.state.targetTemp = target;
    // Debounce: dragging the slider in the Home app fires many sets in a row.
    this.schedule('targetTemp', target, previous, (old) =>
      this.request('post', `/velis/medPlantData/${encodeURIComponent(this.plantId)}/temperature`, {
        eco: false,
        new: target,
        old,
      }).then(() => this.log.info(`Target temperature set to ${target}°C`)));
  }

  setHeatingState(value) {
    const on = value === this.Characteristic.TargetHeatingCoolingState.HEAT;
    const previous = this.state.on;
    this.state.on = on;
    this.heaterService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentHeatingState());
    this.schedule('on', on, previous, () =>
      this.request('post', `/velis/medPlantData/${encodeURIComponent(this.plantId)}/switch`, on)
        .then(() => this.log.info(`Heater turned ${on ? 'ON' : 'OFF'}`)));
  }

  schedule(key, value, previous, send) {
    if (this.setTimers[key]) {
      clearTimeout(this.setTimers[key].timer);
      previous = this.setTimers[key].previous;
    }
    this.pending[key] = { value, until: Date.now() + PENDING_GRACE_MS };
    const timer = setTimeout(async () => {
      delete this.setTimers[key];
      try {
        await send(previous);
      } catch (error) {
        this.log.error(`Command failed, reverting: ${error.message}`);
        delete this.pending[key];
        this.state[key] = previous;
        this.pushStateToHomeKit();
      }
    }, SET_DEBOUNCE_MS);
    this.setTimers[key] = { timer, previous };
  }

  getServices() {
    return [this.informationService, this.heaterService];
  }

  shutdown() {
    clearInterval(this.refreshTimer);
    for (const { timer } of Object.values(this.setTimers)) {
      clearTimeout(timer);
    }
  }
}
