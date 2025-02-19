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
    this.username = process.env.ARISTON_USERNAME || config.username;
    this.password = process.env.ARISTON_PASSWORD || config.password;
    this.plantId = config.plantId;
    this.model = config.model || 'Unknown Model';
    this.serialNumber = config.serial_number || 'Unknown Serial';
    
    // State management
    this.token = null;
    this.tokenExpiry = null;
    this.deviceState = {
      power: false,
      mode: 'manual', // 'manual' hoặc 'timer'
      currentTemp: 30,
      targetTemp: 40,
      heatingActive: false
    };

    // Cache settings
    this.cacheDuration = 30000; // Giảm thời gian cache xuống 30s
    this.lastUpdate = 0;
    
    // Config validation
    this.minTemperature = Math.max(40, config.minTemperature || 40);
    this.maxTemperature = Math.max(this.minTemperature, config.maxTemperature || 100);

    // Khởi tạo services
    this.initServices();
    this.setupAutoRefresh();
    
    this.login().catch(err => this.log.error('Initial login failed:', err));
  }

  initServices() {
    this.heaterService = new Service.Thermostat(this.name);
    
    // Configure characteristics
    this.heaterService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.minTemperature,
        maxValue: this.maxTemperature,
        minStep: 1
      })
      .on('set', this.setTargetTemperature.bind(this))
      .on('get', this.getTargetTemperature.bind(this));

    this.heaterService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('get', this.getCurrentTemperature.bind(this));

    this.heaterService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', this.getHeatingState.bind(this));

    this.heaterService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
          Characteristic.TargetHeatingCoolingState.AUTO
        ]
      })
      .on('set', this.setHeatingState.bind(this));

    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Ariston')
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber);
  }

  setupAutoRefresh() {
    // Tự động cập nhật trạng thái mỗi 30s
    this.refreshInterval = setInterval(async () => {
      try {
        await this.fetchDeviceState();
        this.updateHomekitState();
      } catch (err) {
        this.log.error('Auto-refresh failed:', err);
      }
    }, 30000);
  }

  async fetchDeviceState() {
    try {
      const response = await this.makeRequest(() => 
        axios.get(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}`, {
          headers: { 'ar.authToken': this.token }
        })
      );

      const data = response.data;
      this.deviceState = {
        power: data.on,
        mode: data.mode,
        currentTemp: data.temp || 30,
        targetTemp: data.reqTemp || this.minTemperature,
        heatingActive: data.heatingActive
      };
      this.lastUpdate = Date.now();
    } catch (err) {
      this.log.error('Failed to fetch device state:', err);
    }
  }

  updateHomekitState() {
    // Cập nhật tất cả characteristics
    this.heaterService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .updateValue(this.deviceState.currentTemp);
    
    this.heaterService
      .getCharacteristic(Characteristic.TargetTemperature)
      .updateValue(this.deviceState.targetTemp);
    
    this.heaterService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .updateValue(this.deviceState.heatingActive ? 
        Characteristic.CurrentHeatingCoolingState.HEAT : 
        Characteristic.CurrentHeatingCoolingState.OFF);
    
    this.heaterService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(this.mapModeToTargetState(this.deviceState.mode));
  }

  mapModeToTargetState(mode) {
    return mode === 'timer' ? 
      Characteristic.TargetHeatingCoolingState.AUTO :
      (this.deviceState.power ? 
        Characteristic.TargetHeatingCoolingState.HEAT : 
        Characteristic.TargetHeatingCoolingState.OFF);
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
      this.tokenExpiry = Date.now() + (60 * 60 * 1000);
      this.log.info('Login successful');
    } catch (error) {
      this.log.error('Login failed:', error.response?.data || error.message);
      throw error;
    }
  }

  async makeRequest(requestFunction) {
    await this.ensureToken();
    try {
      return await requestFunction();
    } catch (error) {
      if (error.response?.status === 401) {
        this.log.info('Refreshing expired token...');
        await this.login();
        return requestFunction();
      }
      throw error;
    }
  }

  async ensureToken() {
    if (!this.token || Date.now() >= this.tokenExpiry) {
      await this.login();
    }
  }

  // Các hàm GET/SET characteristics
  async getCurrentTemperature(callback) {
    if (Date.now() - this.lastUpdate > this.cacheDuration) {
      await this.fetchDeviceState();
    }
    callback(null, this.deviceState.currentTemp);
  }

  async getTargetTemperature(callback) {
    if (Date.now() - this.lastUpdate > this.cacheDuration) {
      await this.fetchDeviceState();
    }
    callback(null, this.deviceState.targetTemp);
  }

  async setTargetTemperature(value, callback) {
    try {
      await this.makeRequest(() => 
        axios.post(
          `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/temperature`,
          { eco: false, new: value, old: this.deviceState.targetTemp },
          { headers: { 'ar.authToken': this.token } }
        )
      );
      
      await this.fetchDeviceState(); // Cập nhật lại trạng thái mới nhất
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async setHeatingState(value, callback) {
    try {
      let newMode;
      switch (value) {
        case Characteristic.TargetHeatingCoolingState.AUTO:
          newMode = 'timer';
          break;
        case Characteristic.TargetHeatingCoolingState.HEAT:
          newMode = 'manual';
          break;
        default:
          newMode = 'off';
      }

      await this.makeRequest(() =>
        axios.post(
          `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/mode`,
          { mode: newMode },
          { headers: { 'ar.authToken': this.token } }
        )
      );

      await this.fetchDeviceState(); // Cập nhật lại trạng thái
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  getHeatingState(callback) {
    callback(null, this.deviceState.heatingActive ?
      Characteristic.CurrentHeatingCoolingState.HEAT :
      Characteristic.CurrentHeatingCoolingState.OFF
    );
  }

  getServices() {
    return [this.heaterService, this.informationService];
  }
}