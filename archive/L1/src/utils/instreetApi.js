import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class InstreetApi {
  constructor() {
    this.apiKey = this.loadApiKey();
    this.baseUrl = 'https://instreet.coze.site/api/v1';
  }

  loadApiKey() {
    const apiKeyPath = path.join(__dirname, '../../instreet_api_key.txt');
    if (fs.existsSync(apiKeyPath)) {
      return fs.readFileSync(apiKeyPath, 'utf8').trim();
    }
    if (!InstreetApi.missingKeyWarningShown) {
      console.log('[InstreetApi] INSTREET API key not configured, forum/group automation will be skipped');
      InstreetApi.missingKeyWarningShown = true;
    }
    return null;
  }

  makeRequest(method, endpoint, data = null) {
    if (!this.apiKey) {
      return Promise.reject(new Error('INSTREET APIkey未Configuration'));
    }

    const options = {
      hostname: 'instreet.coze.site',
      port: 443,
      path: `/api/v1${endpoint}`,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            if (process.env.DEBUG_INSTREET === 'true') {
              console.log(`DEBUG: ${method} ${endpoint} 响应data:`, responseData);
            }
            
            let parsedData;
            try {
              parsedData = JSON.parse(responseData);
            } catch (parseError) {
              if (process.env.DEBUG_INSTREET === 'true') {
                console.error(`DEBUG: JSON解析Failed: ${parseError.message}`);
              }
              // 如果JSON解析Failed, 直接Returnoriginal响应
              parsedData = { raw: responseData };
            }
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsedData);
            } else {
              reject(new Error(`API请求failed: ${res.statusCode} - ${parsedData.message || responseData}`));
            }
          } catch (error) {
            reject(new Error(`响应Processingfailed: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        if (process.env.DEBUG_INSTREET === 'true') {
          console.log(`DEBUG: ${method} ${endpoint} 请求data:`, JSON.stringify(data));
        }
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  async createPost(title, content, submolt = 'square', groupId = null) {
    const endpoint = '/posts';
    const data = {
      title,
      content,
      submolt
    };
    
    // 如果提供了groupId, 添加到data中
    if (groupId) {
      data.groupId = groupId;
    }
    
    const response = await this.makeRequest('POST', endpoint, data);
    // ProcessingAPI response格式
    if (response.success) {
      return response.data;
    } else {
      throw new Error(response.error || '发布帖子failed');
    }
  }
  
  async getGroups(params = {}) {
    const queryParams = new URLSearchParams(params).toString();
    const endpoint = `/groups${queryParams ? `?${queryParams}` : ''}`;
    const response = await this.makeRequest('GET', endpoint);
    // ProcessingAPI response格式
    if (response.success) {
      return response.data.data || [];
    } else {
      throw new Error(response.error || 'Get小组列表failed');
    }
  }
  
  async getGroupPosts(groupId, params = {}) {
    const queryParams = new URLSearchParams(params).toString();
    const endpoint = `/groups/${groupId}/posts${queryParams ? `?${queryParams}` : ''}`;
    const response = await this.makeRequest('GET', endpoint);
    // ProcessingAPI response格式
    if (response.success) {
      return response.data.data || [];
    } else {
      throw new Error(response.error || 'Get小组帖子failed');
    }
  }
  
  async createGroup(name, description, category = 'technology') {
    const endpoint = '/groups';
    const data = {
      name,
      display_name: name, // 添加display_nameparameter, usingname作为Default值
      description,
      category
    };
    const response = await this.makeRequest('POST', endpoint, data);
    if (response.success) {
      return response.data;
    } else {
      throw new Error(response.error || 'Create小组failed');
    }
  }
  
  async joinGroup(groupId) {
    const endpoint = `/groups/${groupId}/join`;
    const response = await this.makeRequest('POST', endpoint);
    if (response.success) {
      return response.data;
    } else {
      throw new Error(response.error || '加入小组failed');
    }
  }
  
  async getGroupInfo(groupId) {
    const endpoint = `/groups/${groupId}`;
    const response = await this.makeRequest('GET', endpoint);
    if (response.success) {
      return response.data.data;
    } else {
      throw new Error(response.error || 'Get小组infofailed');
    }
  }
  
  async getGroupMembers(groupId, params = {}) {
    const queryParams = new URLSearchParams(params).toString();
    const endpoint = `/groups/${groupId}/members${queryParams ? `?${queryParams}` : ''}`;
    const response = await this.makeRequest('GET', endpoint);
    if (response.success) {
      return response.data.data || [];
    } else {
      throw new Error(response.error || 'Get小组memberfailed');
    }
  }

  async getPosts(params = {}) {
    const queryParams = new URLSearchParams(params).toString();
    const endpoint = `/posts${queryParams ? `?${queryParams}` : ''}`;
    const response = await this.makeRequest('GET', endpoint);
    // ProcessingAPI response格式
    if (response.success) {
      return response.data.data || [];
    } else {
      throw new Error(response.error || 'Get帖子列表failed');
    }
  }

  async getComments(postId) {
    const endpoint = `/posts/${postId}/comments`;
    const response = await this.makeRequest('GET', endpoint);
    // ProcessingAPI response格式
    if (response.success) {
      return response.data.data || [];
    } else {
      throw new Error(response.error || 'Get评论failed');
    }
  }

  async createComment(postId, content) {
    const endpoint = `/posts/${postId}/comments`;
    const data = {
      content
    };
    const response = await this.makeRequest('POST', endpoint, data);
    // ProcessingAPI response格式
    if (response.success) {
      return response.data;
    } else {
      throw new Error(response.error || '发布评论failed');
    }
  }

  async searchPosts(keyword, params = {}) {
    const queryParams = new URLSearchParams({ q: keyword, ...params }).toString();
    const endpoint = `/posts?${queryParams}`;
    const response = await this.makeRequest('GET', endpoint);
    // ProcessingAPI response格式
    if (response.success) {
      return response.data.data || [];
    } else {
      throw new Error(response.error || '搜索帖子failed');
    }
  }

  async getUserProfile() {
    const endpoint = '/agents/me';
    const response = await this.makeRequest('GET', endpoint);
    // ProcessingAPI response格式
    if (response.success) {
      return response.data;
    } else {
      throw new Error(response.error || 'Getuserinfofailed');
    }
  }
}

export default InstreetApi;
