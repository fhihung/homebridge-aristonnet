const axios = require('axios');
let Accessory, Service, Characteristic, UUIDGen;

module.exports = (homebridge) => {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerAccessory('homebridge-aristonnet', 'AristonWaterHeater', AristonWaterHeater);
};

class AristonWaterHeater {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'Ariston Heater';
    this.username = config.username;
    this.password = config.password;
    this.plantId = config.plantId;
    this.model = config.model || 'Unknown Model';
    this.serialNumber = config.serial_number || 'Unknown Serial';
    this.minTemp = config.minTemp || 40; // Thêm dòng này
    this.maxTemp = config.maxTemp || 80; // Thêm dòng này

    this.token = null;
    this.tokenExpiry = null;
    this.isFetching = false;
    this.lastFetchTime = 0;

    // Cache configuration
    this.cacheDuration = 300000; // 5 minutes
    this.activeRefreshThreshold = 10000; // 10 seconds
    this.cachedData = {
      currentTemp: 40,
      targetTemp: 40,
      powerState: false
    };

    // Initialize services
    this.heaterService = new Service.Thermostat(this.name);
    this.configureCharacteristics();
    
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Ariston')
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber);

    // Setup auto refresh
    this.initializeAutoRefresh();
    this.login().catch(err => this.log('Initial login error:', err));
  }

  initializeAutoRefresh() {
    // Initial fetch
    this.fetchDeviceState().catch(err => this.log('Initial fetch error:', err));
    
    // Periodic refresh every 5 minutes
    this.autoRefreshInterval = setInterval(() => {
      this.fetchDeviceState().catch(err => this.log('Auto refresh error:', err));
    }, this.cacheDuration);
  }

  configureCharacteristics() {
    // Target Temperature
    this.heaterService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.minTemp, 
        maxValue: this.maxTemp,
        minStep: 1
      })
      .on('set', this.setTargetTemperature.bind(this))
      .on('get', (cb) => this.handleGetRequest('targetTemp', cb));

    // Current Temperature
    this.heaterService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('get', (cb) => this.handleGetRequest('currentTemp', cb));

    // Current Heating State
    this.heaterService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', (cb) => this.handleGetRequest('powerState', cb));

    // Target Heating State
    this.heaterService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]
      })
      .on('set', this.setHeatingState.bind(this));
  }

  async handleGetRequest(type, callback) {
    try {
      const now = Date.now();
      const timeSinceLastFetch = now - this.lastFetchTime;
      
      if (timeSinceLastFetch > this.activeRefreshThreshold && !this.isFetching) {
        await this.fetchDeviceState();
      }

      this.sendCachedValue(type, callback);
    } catch (error) {
      this.log(`Error handling get request for ${type}:`, error);
      this.sendCachedValue(type, callback);
    }
  }

  sendCachedValue(type, callback) {
    switch(type) {
      case 'currentTemp':
        callback(null, this.cachedData.currentTemp);
        break;
      case 'powerState':
        callback(null, this.cachedData.powerState ? 
          Characteristic.CurrentHeatingCoolingState.HEAT : 
          Characteristic.CurrentHeatingCoolingState.OFF);
        break;
      case 'targetTemp':
        callback(null, this.cachedData.targetTemp);
        break;
    }
  }

  async fetchDeviceState() {
    if (this.isFetching) return;
    this.isFetching = true;

    try {
      if (!this.token || Date.now() >= this.tokenExpiry) {
        await this.login();
      }

      const response = await this.retryRequest(() => 
        axios.get(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}`, {
          headers: { 'ar.authToken': this.token },
        })
      );

      this.updateCache(response.data);
      this.updateCharacteristics();
      this.lastFetchTime = Date.now();
      this.log('Device state updated successfully');
    } catch (error) {
      this.log('Failed to fetch device state:', error);
      throw error;
    } finally {
      this.isFetching = false;
    }
  }

  updateCache(data) {
    this.cachedData = {
      currentTemp: data.temp || this.cachedData.currentTemp,
      targetTemp: data.procReqTemp || data.reqTemp || this.cachedData.targetTemp,
      powerState: data.on || this.cachedData.powerState
    };
  }

  updateCharacteristics() {
    this.heaterService
      .updateCharacteristic(Characteristic.CurrentTemperature, this.cachedData.currentTemp);
    this.heaterService
      .updateCharacteristic(Characteristic.TargetTemperature, this.cachedData.targetTemp);
    this.heaterService
      .updateCharacteristic(Characteristic.CurrentHeatingCoolingState, 
        this.cachedData.powerState ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF);
    this.heaterService
      .updateCharacteristic(Characteristic.TargetHeatingCoolingState, 
        this.cachedData.powerState ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF);
  }

  async login() {
    try {
      const response = await axios.post('https://www.ariston-net.remotethermo.com/api/v2/accounts/login', {
        usr: this.username,
        pwd: this.password,
        imp: false,
        notTrack: true,
        appInfo: {
          os: 2,
          appVer: '5.6.7772.40151',
          appId: 'com.remotethermo.aristonnet',
        },
      });

      this.token = response.data.token;
      this.tokenExpiry = Date.now() + 3600000; // 1 hour expiry
      this.log('Login successful');
    } catch (error) {
      this.log('Login failed:', error);
      throw error;
    }
  }

  async setTargetTemperature(value, callback) {
    try {
      const oldValue = this.cachedData.targetTemp;
      
      await this.retryRequest(() => 
        axios.post(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/temperature`, {
          eco: false,
          new: value,
          old: oldValue,
        }, {
          headers: {
            'ar.authToken': this.token,
            'Content-Type': 'application/json',
          },
        })
      );

      this.log(`Temperature set: ${oldValue}°C → ${value}°C`);
      await this.fetchDeviceState();
      callback(null);
    } catch (error) {
      this.log('Set temperature failed:', error);
      callback(error);
    }
  }

  async setHeatingState(value, callback) {
    try {
      const newState = value === Characteristic.TargetHeatingCoolingState.HEAT;
      
      await this.retryRequest(() => 
        axios.post(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switch`, newState, {
          headers: {
            'ar.authToken': this.token,
            'Content-Type': 'application/json',
          },
        })
      );

      await this.fetchDeviceState();
      callback(null);
    } catch (error) {
      this.log('Set power state failed:', error);
      callback(error);
    }
  }

  async retryRequest(requestFn, retries = 3, delay = 5000) {
    for (let i = 0; i < retries; i++) {
      try {
        if (Date.now() >= this.tokenExpiry) await this.login();
        return await requestFn();
      } catch (error) {
        if (i === retries - 1) throw error;
        
        if (error.response?.status === 401) {
          this.log('Refreshing expired token...');
          await this.login();
        } else if (error.response?.status === 429) {
          this.log(`Rate limited, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  getServices() {
    return [this.heaterService, this.informationService];
  }

  shutdown() {
    clearInterval(this.autoRefreshInterval);
  }
}