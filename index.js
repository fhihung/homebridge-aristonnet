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
    this.powerState = false;
    this.targetTemperature = 30;

    // Thời gian cache dữ liệu (ms)
    this.cacheDuration = 60000; // 1 phút
    this.lastFetchedTime = 0;
    this.cachedTemperature = 30;

    this.heaterService = new Service.Thermostat(this.name);

    this.heaterService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: 30,
        maxValue: 100,
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
        validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]
      })
      .on('set', this.setHeatingState.bind(this));

    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Ariston')
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber);

    this.login();
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
      }, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      this.token = response.data.token;
      this.log('Login successful, token received:', this.token);
    } catch (error) {
      this.log('Error logging in:', error);
    }
  }

  async getCurrentTemperature(callback) {
    const currentTime = Date.now();
    
    // Kiểm tra cache để tránh gọi API quá nhiều
    if (currentTime - this.lastFetchedTime < this.cacheDuration) {
      this.log('Returning cached temperature:', this.cachedTemperature);
      callback(null, this.cachedTemperature);
      return;
    }

    if (!this.token) {
      callback(null, 30); // Mặc định là 30 nếu không có token
      return;
    }

    try {
      const response = await this.retryRequest(() => axios.get(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}`, {
        headers: {
          'ar.authToken': this.token,
        },
      }));

      let currentTemperature = response.data.temp;

      if (typeof currentTemperature !== 'number' || !isFinite(currentTemperature)) {
        this.log('Current temperature is invalid, defaulting to 30°C');
        currentTemperature = 30; // Mặc định là 30°C nếu không hợp lệ
      }

      this.cachedTemperature = currentTemperature;
      this.lastFetchedTime = Date.now(); // Cập nhật thời gian cache

      this.log('Current temperature:', currentTemperature);
      callback(null, currentTemperature);
    } catch (error) {
      this.log('Error getting current temperature:', error);
      callback(null, 30); // Mặc định là 30°C nếu lỗi
    }
  }

  async getTargetTemperature(callback) {
    if (!this.token || !this.powerState) {
      callback(null, this.targetTemperature); // Trả về giá trị đã lưu
      return;
    }

    try {
      const response = await this.retryRequest(() => axios.get(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}`, {
        headers: {
          'ar.authToken': this.token,
        },
      }));

      let procReqTemp = response.data.procReqTemp;
      let reqTemp = response.data.reqTemp;
      this.targetTemperature = procReqTemp || reqTemp || 30; // Lấy từ procReqTemp hoặc reqTemp, mặc định là 30

      this.log('Target temperature:', this.targetTemperature);
      callback(null, this.targetTemperature);
    } catch (error) {
      this.log('Error getting target temperature:', error);
      callback(null, 30); // Mặc định là 30°C nếu lỗi
    }
  }

  async retryRequest(requestFunction, retries = 3, delay = 5000) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await requestFunction();
      } catch (error) {
        if (error.response && error.response.status === 429) {
          this.log(`Rate limited, retrying after ${delay}ms...`);
          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }
    throw new Error('Max retries reached');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async setTargetTemperature(value, callback) {
    if (!this.token) {
      this.log('No token, cannot set temperature');
      callback(new Error('No token'));
      return;
    }

    value = Math.max(30, Math.min(value, 100)); // Giới hạn nhiệt độ từ 30 đến 100
    this.targetTemperature = value;

    try {
      const response = await axios.post(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/temperature`, {
        eco: false,
        new: value,
        old: 70,  // Cần lấy giá trị cũ từ hệ thống nếu cần
      }, {
        headers: {
          'ar.authToken': this.token,
          'Content-Type': 'application/json',
        },
      });

      if (response.data.success) {
        this.log(`Target temperature set to ${value}°C`);
        callback(null);
      } else {
        this.log('Error setting target temperature');
        callback(new Error('Failed to set target temperature'));
      }
    } catch (error) {
      this.log('Error setting temperature:', error);
      callback(error);
    }
  }

  async setHeatingState(value, callback) {
    if (!this.token) {
      callback(new Error('No token'));
      return;
    }

    const powerState = value === Characteristic.TargetHeatingCoolingState.HEAT;
    this.powerState = powerState; // Cập nhật trạng thái bật/tắt
    this.log(powerState ? 'Turning heater ON' : 'Turning heater OFF');

    try {
      const response = await axios.post(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switch`, powerState, {
        headers: {
          'ar.authToken': this.token,
          'Content-Type': 'application/json',
        },
      });

      if (response.data.success) {
        this.log('Heater state updated successfully');
        callback(null);
      } else {
        this.log('Error updating heater state');
        callback(new Error('Failed to update heater state'));
      }
    } catch (error) {
      this.log('Error updating heater state:', error);
      callback(error);
    }
  }

  getHeatingState(callback) {
    if (this.powerState) {
      callback(null, Characteristic.CurrentHeatingCoolingState.HEAT);
    } else {
      callback(null, Characteristic.CurrentHeatingCoolingState.OFF);
    }
  }

  getServices() {
    return [this.heaterService, this.informationService]; // Bao gồm cả AccessoryInformation
  }
}