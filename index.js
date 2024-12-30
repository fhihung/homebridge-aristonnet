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
    this.token = null;
    this.tokenExpiry = null; // Thời gian hết hạn token
    this.powerState = false;
    this.targetTemperature = 40; // Đặt giá trị mặc định từ minTemperature

    // Thời gian cache dữ liệu (ms)
    this.cacheDuration = 60000; // 1 phút
    this.lastFetchedTime = 0;
    this.cachedTemperature = 30;

    // Đọc minTemperature và maxTemperature từ cấu hình hoặc sử dụng giá trị mặc định
    this.minTemperature = typeof config.minTemperature === 'number' ? config.minTemperature : 40;
    this.maxTemperature = typeof config.maxTemperature === 'number' ? config.maxTemperature : 100;

    // Đảm bảo minTemperature không nhỏ hơn 40°C để tuân thủ yêu cầu của Homebridge
    if (this.minTemperature < 40) {
      this.log.warn(`minTemperature (${this.minTemperature}°C) is less than 40°C. Đặt lại về 40°C để tuân thủ yêu cầu của Homebridge.`);
      this.minTemperature = 40;
    }

    // Đảm bảo maxTemperature không nhỏ hơn minTemperature
    if (this.maxTemperature < this.minTemperature) {
      this.log.warn(`maxTemperature (${this.maxTemperature}°C) nhỏ hơn minTemperature (${this.minTemperature}°C). Đặt lại maxTemperature bằng minTemperature.`);
      this.maxTemperature = this.minTemperature;
    }

    this.heaterService = new Service.Thermostat(this.name);

    // Định nghĩa các thuộc tính Thermostat với giới hạn từ cấu hình
    this.heaterService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.minTemperature, // Được đọc từ cấu hình
        maxValue: this.maxTemperature, // Được đọc từ cấu hình
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

    // Kiểm tra thông tin đăng nhập
    if (!this.username || !this.password) {
      this.log.error('Username and/or password not provided. Please set them in config or environment variables.');
      return;
    }

    this.login();
  }

  /**
   * Đăng nhập và lấy token
   */
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
      // Giả sử token có thời gian sống (thời gian hết hạn), ví dụ 1 giờ
      this.tokenExpiry = Date.now() + (60 * 60 * 1000); // 1 giờ
      this.log.info('Login successful, token received.');
    } catch (error) {
      this.log.error('Error logging in:', error.response ? error.response.data : error.message);
    }
  }

  /**
   * Kiểm tra và làm mới token nếu cần
   */
  async ensureToken() {
    if (!this.token || Date.now() >= this.tokenExpiry) {
      this.log.info('Token is missing or expired. Re-authenticating...');
      await this.login();
      if (!this.token) {
        throw new Error('Authentication failed');
      }
    }
  }

  /**
   * Hàm yêu cầu HTTP với retry và quản lý token
   */
  async makeRequest(requestFunction, retries = 3, delay = 5000) {
    await this.ensureToken();

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await requestFunction();
      } catch (error) {
        if (error.response) {
          if (error.response.status === 401) { // Unauthorized, có thể token hết hạn
            this.log.warn('Unauthorized. Token may have expired. Re-authenticating...');
            await this.login();
            if (!this.token) {
              throw new Error('Re-authentication failed');
            }
          } else if (error.response.status === 429) { // Rate limited
            this.log.warn(`Rate limited, retrying after ${delay}ms...`);
            await this.sleep(delay);
          } else {
            throw error;
          }
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

  /**
   * Lấy nhiệt độ hiện tại với caching
   */
  async getCurrentTemperature(callback) {
    const currentTime = Date.now();

    // Kiểm tra cache để tránh gọi API quá nhiều
    if (currentTime - this.lastFetchedTime < this.cacheDuration) {
      this.log.info('Returning cached temperature:', this.cachedTemperature);
      callback(null, this.cachedTemperature);
      return;
    }

    try {
      const response = await this.makeRequest(() => axios.get(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}`, {
        headers: {
          'ar.authToken': this.token,
        },
      }));

      let currentTemperature = response.data.temp;

      if (typeof currentTemperature !== 'number' || !isFinite(currentTemperature)) {
        this.log.warn('Current temperature is invalid, defaulting to 30°C');
        currentTemperature = 30; // Mặc định là 30°C nếu không hợp lệ
      }

      this.cachedTemperature = currentTemperature;
      this.lastFetchedTime = Date.now(); // Cập nhật thời gian cache

      this.log.info('Current temperature:', currentTemperature);
      callback(null, currentTemperature);
    } catch (error) {
      this.log.error('Error getting current temperature:', error.response ? error.response.data : error.message);
      callback(null, 30); // Mặc định là 30°C nếu lỗi
    }
  }

  /**
   * Lấy nhiệt độ mục tiêu
   */
  async getTargetTemperature(callback) {
    try {
      await this.ensureToken();

      if (!this.powerState) {
        this.log.info('Heater is OFF. Returning stored target temperature:', this.targetTemperature);
        callback(null, this.targetTemperature); // Trả về giá trị đã lưu
        return;
      }

      const response = await this.makeRequest(() => axios.get(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}`, {
        headers: {
          'ar.authToken': this.token,
        },
      }));

      let procReqTemp = response.data.procReqTemp;
      let reqTemp = response.data.reqTemp;
      this.targetTemperature = procReqTemp || reqTemp || this.minTemperature; // Lấy từ procReqTemp hoặc reqTemp, mặc định là minTemperature

      this.log.info('Target temperature:', this.targetTemperature);
      callback(null, this.targetTemperature);
    } catch (error) {
      this.log.error('Error getting target temperature:', error.response ? error.response.data : error.message);
      callback(null, this.targetTemperature || this.minTemperature); // Mặc định là minTemperature nếu lỗi
    }
  }

  /**
   * Đặt nhiệt độ mục tiêu
   */
  async setTargetTemperature(value, callback) {
    try {
      await this.ensureToken();

      // Giới hạn nhiệt độ từ minTemperature đến maxTemperature
      value = Math.max(this.minTemperature, Math.min(value, this.maxTemperature));
      this.targetTemperature = value;

      // Lấy giá trị cũ từ hệ thống
      const response = await this.makeRequest(() => axios.get(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}`, {
        headers: {
          'ar.authToken': this.token,
        },
      }));

      let oldTemperature = response.data.procReqTemp || response.data.reqTemp || 70; // Lấy giá trị cũ hoặc mặc định 70°C

      // Gửi yêu cầu cập nhật nhiệt độ
      const setTempResponse = await this.makeRequest(() => axios.post(`https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/temperature`, {
        eco: false,
        new: value,
        old: oldTemperature, // Sử dụng giá trị cũ thực tế
      }, {
        headers: {
          'ar.authToken': this.token,
          'Content-Type': 'application/json',
        },
      }));

      if (setTempResponse.data.success) {
        this.log.info(`Target temperature set to ${value}°C`);
        callback(null);
      } else {
        this.log.warn('Error setting target temperature');
        callback(new Error('Failed to set target temperature'));
      }
    } catch (error) {
      this.log.error('Error setting temperature:', error.response ? error.response.data : error.message);
      callback(error);
    }
  }

  /**
   * Đặt trạng thái bật/tắt (bao gồm cả chế độ AUTO)
   */
  async setHeatingState(value, callback) {
    try {
      await this.ensureToken();

      let powerState;
      if (value === Characteristic.TargetHeatingCoolingState.AUTO) {
        // Xử lý chế độ "Auto" (đặt chế độ theo lịch trình)
        this.log.info('Setting heater to Schedule Mode');
        powerState = 'timer'; // Thay thế bằng giá trị API thực tế cho chế độ lịch trình
      } else {
        powerState = value === Characteristic.TargetHeatingCoolingState.HEAT;
        this.powerState = powerState;
        this.log.info(powerState ? 'Turning heater ON' : 'Turning heater OFF');
      }

      const response = await this.makeRequest(() => axios.post(
        `https://www.ariston-net.remotethermo.com/api/v2/velis/medPlantData/${this.plantId}/switch`,
        powerState,
        {
          headers: {
            'ar.authToken': this.token,
            'Content-Type': 'application/json',
          },
        }
      ));

      if (response.data.success) {
        this.log.info('Heater state updated successfully');
        callback(null);
      } else {
        this.log.warn('Error updating heater state');
        callback(new Error('Failed to update heater state'));
      }
    } catch (error) {
      this.log.error('Error updating heater state:', error.response ? error.response.data : error.message);
      callback(error);
    }
  }

  /**
   * Lấy trạng thái hiện tại của máy nước nóng
   */
  getHeatingState(callback) {
    if (this.powerState) {
      callback(null, Characteristic.CurrentHeatingCoolingState.HEAT);
    } else {
      callback(null, Characteristic.CurrentHeatingCoolingState.OFF);
    }
  }

  /**
   * Đăng ký các dịch vụ cho Homebridge
   */
  getServices() {
    return [this.heaterService, this.informationService]; // Bao gồm cả AccessoryInformation
  }
}