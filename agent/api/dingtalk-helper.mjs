// DingTalk helper — extracted from report-api.mjs
import https from 'https';

// 获取钉钉 access token
export async function getDingtalkToken() {
  const clientId = process.env.DINGTALK_CLIENT_ID;
  const clientSecret = process.env.DINGTALK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('DINGTALK_CLIENT_ID 或 DINGTALK_CLIENT_SECRET 未配置');
  }

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ appKey: clientId, appSecret: clientSecret });
    const options = {
      hostname: 'api.dingtalk.com',
      path: '/v1.0/oauth2/accessToken',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.accessToken) {
            resolve(parsed.accessToken);
          } else {
            reject(new Error(`获取 Token 失败: ${data}`));
          }
        } catch (e) {
          reject(new Error(`解析 Token 响应失败: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 通过 access token 调用钉钉旧版 API（GET, oapi.dingtalk.com）
// 旧版 oapi 需要 URL 参数 access_token，不能用 header 鉴权
export async function dingtalkGet(accessToken, path, params = {}) {
  const allParams = { access_token: accessToken, ...params };
  const qs = new URLSearchParams(allParams).toString();
  const fullPath = `${path}?${qs}`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'oapi.dingtalk.com',
      path: fullPath,
      method: 'GET',
      headers: {},
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`解析响应失败: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 通过 v1.0 API 调用（GET, api.dingtalk.com）
export async function dingtalkV1Get(accessToken, apiPath, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const fullPath = qs ? `${apiPath}?${qs}` : apiPath;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.dingtalk.com',
      path: fullPath,
      method: 'GET',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`解析响应失败: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 通过 v1.0 API 调用（POST, api.dingtalk.com）
export async function dingtalkV1Post(accessToken, apiPath, body = {}) {
  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.dingtalk.com',
      path: apiPath,
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`解析响应失败: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}
