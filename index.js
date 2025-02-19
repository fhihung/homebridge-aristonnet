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
      mode: 'manual',
      currentTemp: 30,
      targetTemp: 40,
      heatingActive: false,
      eco: false 
    };

    // Cache và refresh
    this.cacheDuration = 30000; // Cache trong 30 giây
    this.lastUpdate = 0;
    this.lastAPICall = 0;
    this.minAPICallInterval = 30000; // Tối thiểu 30 giây giữa các lần call API
    this.refreshTimeout = null;

    // Config validation
    this.minTemperature = Math.max(40, config.minTemperature || 40);
    this.maxTemperature = Math.max(this.minTemperature, config.maxTemperature || 80);

    this.initServices();
    this.log.info('Ariston Water Heater initialized');
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
    const now = Date.now();
    if (now - this.lastAPICall < this.minAPICallInterval) {
      this.log.debug('Skipping API call: Too frequent');
      return;
    }

    try {
      this.log.debug('Fetching device state from API...');
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
        heatingActive: data.heatingActive,
        eco: data.eco // Giả sử API trả về trường eco
      };
      this.lastUpdate = Date.now();
      this.lastAPICall = Date.now();
      this.log.info('Device state updated successfully');
    } catch (err) {
      this.log.error('Failed to fetch device state:', err);
      throw err;
    }
  }

  mapModeToTargetState() {
    if (this.deviceState.eco) {
      return Characteristic.TargetHeatingCoolingState.AUTO;
    } else if (this.deviceState.power) {
      return Characteristic.TargetHeatingCoolingState.HEAT;
    } else {
      return Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  async makeRequest(requestFunction) {
    await this.ensureToken();
    try {
      const response = await requestFunction();
      const config = response.config;
      this.log.info(`✅ API Success: ${config.method.toUpperCase()} ${config.url}`);
      return response;
    } catch (error) {
      const config = error.config;
      this.log.error(`❌ API Failed: ${config?.method?.toUpperCase() || 'UNKNOWN'} ${config?.url || 'UNKNOWN'} - ${error.message}`);
      
      if (error.response?.status === 401) {
        this.log.info('🔄 Refreshing expired token...');
        await this.login();
        return requestFunction();
      }
      throw error;
    }
  }
    // Cải tiến các hàm GET
    getCurrentTemperature(callback) {
      this.log.debug('📡 Getting current temperature');
      this.handleGetRequest();
      callback(null, this.deviceState.currentTemp);
    }
  
    getTargetTemperature(callback) {
      this.log.debug('📡 Getting target temperature');
      this.handleGetRequest();
      callback(null, this.deviceState.targetTemp);
    }
  
    async handleGetRequest() {
      const now = Date.now();
      if (now - this.lastUpdate > this.cacheDuration) {
        this.log.debug('Cache expired, refreshing device state...');
        try {
          await this.fetchDeviceState();
          this.updateHomekitState();
        } catch (err) {
          this.log.error('Background refresh failed:', err);
        }
      } else {
        this.log.debug('Using cached device state');
      }
    }
  
    scheduleDebouncedRefresh() {
      if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
      
      this.refreshTimeout = setTimeout(() => {
        this.fetchDeviceState()
          .then(() => {
            this.updateHomekitState();
            this.log.debug('🔄 Device state updated by debounced refresh');
          })
          .catch(err => this.log.error('Debounced refresh failed:', err));
      }, 500);
    }

  // Cập nhật các giá trị cho HomeKit
  updateHomekitState() {
    this.log.debug('🔄 Updating HomeKit characteristics');
    
    [
      [Characteristic.CurrentTemperature, this.deviceState.currentTemp],
      [Characteristic.TargetTemperature, this.deviceState.targetTemp],
      [Characteristic.CurrentHeatingCoolingState, this.deviceState.heatingActive ? 1 : 0],
      [Characteristic.TargetHeatingCoolingState, this.mapModeToTargetState()]
    ].forEach(([characteristic, value]) => {
      this.heaterService.getCharacteristic(characteristic).updateValue(value);
    });
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

  async ensureToken() {
    if (!this.token || Date.now() >= this.tokenExpiry) {
      await this.login();
    }
  }

  async getCurrentTemperature(callback) {
    this.log.debug('Getting current temperature');
    this.handleGetRequest().finally(() => {
      callback(null, this.deviceState.currentTemp);
    });
  }

  async getTargetTemperature(callback) {
    this.log.debug('Getting target temperature');
    this.handleGetRequest().finally(() => {
      callback(null, this.deviceState.targetTemp);
    });
  }

  async setTargetTemperature(value, callback) {
    this.log.debug(`Setting target temperature to ${value}`);
    try {
      await this.makeRequest(() => 
        axios.post(
          `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/temperature`,
          { eco: false, new: value, old: this.deviceState.targetTemp },
          { headers: { 'ar.authToken': this.token } }
        )
      );
      
      // Cập nhật state sau khi set thành công
      await this.fetchDeviceState();
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async setHeatingState(value, callback) {
    this.log.debug(`Setting heating state to ${value}`);
    try {
      let actions = [];

      switch (value) {
        case Characteristic.TargetHeatingCoolingState.AUTO:
          // Bật thiết bị nếu đang tắt
          if (!this.deviceState.power) {
            actions.push(this.makeRequest(() =>
              axios.post(
                `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switch`,
                true,
                { headers: { 'ar.authToken': this.token } }
              )
            ));
          }
          // Bật Eco và đặt mode timer
          actions.push(
            this.makeRequest(() =>
              axios.post(
                `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switchEco`,
                true,
                { headers: { 'ar.authToken': this.token } }
              )
            ),
            this.makeRequest(() =>
              axios.post(
                `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/mode`,
                { mode: 'timer' },
                { headers: { 'ar.authToken': this.token } }
              )
            )
          );
          break;

        case Characteristic.TargetHeatingCoolingState.HEAT:
          // Tắt Eco và đặt mode manual
          actions.push(
            this.makeRequest(() =>
              axios.post(
                `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switchEco`,
                false,
                { headers: { 'ar.authToken': this.token } }
              )
            ),
            this.makeRequest(() =>
              axios.post(
                `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/mode`,
                { mode: 'manual' },
                { headers: { 'ar.authToken': this.token } }
              )
            )
          );
          // Bật thiết bị nếu đang tắt
          if (!this.deviceState.power) {
            actions.push(this.makeRequest(() =>
              axios.post(
                `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switch`,
                true,
                { headers: { 'ar.authToken': this.token } }
              )
            ));
          }
          break;

        case Characteristic.TargetHeatingCoolingState.OFF:
          // Tắt thiết bị và Eco
          actions.push(
            this.makeRequest(() =>
              axios.post(
                `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switch`,
                false,
                { headers: { 'ar.authToken': this.token } }
              )
            ),
            this.makeRequest(() =>
              axios.post(
                `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switchEco`,
                false,
                { headers: { 'ar.authToken': this.token } }
              )
            )
          );
          break;
      }

      // Thực hiện tuần tự các hành động
      for (const action of actions) {
        await action;
      }

      // Cập nhật trạng thái mới nhất
      await this.fetchDeviceState();
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