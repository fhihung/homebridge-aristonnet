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
    
    this.token = null;
    this.tokenExpiry = null;
    this.powerState = false;
    this.targetTemperature = 30;

    // Cache settings
    this.cacheDuration = 30000; // 30 seconds
    this.lastFetched = {
      currentTemp: 0,
      targetTemp: 0,
      powerState: 0
    };
    
    this.cachedData = {
      currentTemp: 30,
      targetTemp: 30,
      powerState: false
    };

    this.heaterService = new Service.Thermostat(this.name);

    // Setup characteristics
    this.configureCharacteristics();
    
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Ariston')
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber);

    this.login();
  }

  configureCharacteristics() {
    // Target Temperature
    this.heaterService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: 30,
        maxValue: 100,
        minStep: 1
      })
      .on('set', this.setTargetTemperature.bind(this))
      .on('get', this.getTargetTemperature.bind(this));

    // Current Temperature
    this.heaterService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('get', (cb) => {
        this.handleGetRequest('currentTemp', cb);
      });

    // Heating State
    this.heaterService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', (cb) => {
        this.handleGetRequest('powerState', cb);
      });

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
      // Force refresh if cache expired
      if (Date.now() - this.lastFetched[type] > this.cacheDuration) {
        await this.fetchDeviceState();
      }
      
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
    } catch (error) {
      this.log(`Error getting ${type}:`, error);
      callback(null, this.cachedData[type]);
    }
  }

  async fetchDeviceState() {
    if (!this.token) {
      await this.login();
    }

    try {
      const response = await this.retryRequest(() => 
        axios.get(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}`, {
          headers: { 'ar.authToken': this.token },
        })
      );

      const now = Date.now();
      this.cachedData = {
        currentTemp: response.data.temp || this.cachedData.currentTemp,
        targetTemp: response.data.procReqTemp || response.data.reqTemp || this.cachedData.targetTemp,
        powerState: response.data.on || this.cachedData.powerState
      };
      
      this.lastFetched = {
        currentTemp: now,
        targetTemp: now,
        powerState: now
      };

      this.log('State updated:', this.cachedData);
    } catch (error) {
      this.log('Failed to fetch device state:', error);
      throw error;
    }
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
      this.lastFetched.targetTemp = 0; // Invalidate cache
      callback(null);
    } catch (error) {
      this.log('Set temperature failed:', error);
      callback(error);
    }
  }

  async setHeatingState(value, callback) {
    try {
      const newState = value === Characteristic.TargetHeatingCoolingState.HEAT;
      this.log(`Setting power state: ${newState ? 'ON' : 'OFF'}`);

      await this.retryRequest(() => 
        axios.post(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switch`, newState, {
          headers: {
            'ar.authToken': this.token,
            'Content-Type': 'application/json',
          },
        })
      );

      this.lastFetched.powerState = 0; // Invalidate cache
      callback(null);
    } catch (error) {
      this.log('Set power state failed:', error);
      callback(error);
    }
  }

  async retryRequest(requestFn, retries = 3, delay = 5000) {
    for (let i = 0; i < retries; i++) {
      try {
        // Check token expiry
        if (Date.now() >= this.tokenExpiry) {
          await this.login();
        }
        return await requestFn();
      } catch (error) {
        if (i === retries - 1) throw error;
        
        if (error.response?.status === 401) {
          this.log('Token expired, refreshing...');
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
}