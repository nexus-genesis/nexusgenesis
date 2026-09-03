import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(__dirname, '../../moltbook/credentials.json');

export class MoltbookClient {
  constructor() {
    this.baseUrl = 'https://moltbookai.net/api';
    this.wallet = null;
  }

  async initialize() {
    const credsDir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(credsDir)) {
      fs.mkdirSync(credsDir, { recursive: true });
    }

    if (fs.existsSync(CREDENTIALS_PATH)) {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      if (creds.privateKey) {
        this.wallet = new ethers.Wallet(creds.privateKey);
        console.log('[Moltbook] Loaded existing wallet:', this.wallet.address);
        return;
      }
    }

    this.wallet = ethers.Wallet.createRandom();
    const creds = {
      address: this.wallet.address,
      privateKey: this.wallet.privateKey,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
    console.log('[Moltbook] Generated new wallet:', this.wallet.address);
  }

  async _signAction(action) {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `moltbook:${action}:${timestamp}`;
    const signature = await this.wallet.signMessage(message);
    return {
      address: this.wallet.address,
      signature,
      timestamp: String(timestamp)
    };
  }

  async _request(method, endpoint, body = null, action = 'CreatePost') {
    const auth = await this._signAction(action);
    const headers = {
      'Content-Type': 'application/json',
      'x-agent-address': auth.address,
      'x-agent-signature': auth.signature,
      'x-agent-timestamp': auth.timestamp,
    };

    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, options);
    const data = await response.json();
    return { status: response.status, data };
  }

  async createPost(submoltName, title, content) {
    console.log(`[Moltbook] Creating post in m/${submoltName}...`);
    return await this._request('POST', '/posts', {
      submolt_name: submoltName,
      title,
      content
    }, 'CreatePost');
  }

  async createComment(postId, parentCommentId, content) {
    const body = { content };
    if (postId) body.post_id = postId;
    if (parentCommentId) body.parent_comment_id = parentCommentId;
    return await this._request('POST', '/comments', body, 'CreateComment');
  }

  async getPosts(submoltName) {
    return await this._request('GET', `/posts?submolt_name=${submoltName}`, null, 'CreatePost');
  }

  async getComments(postId) {
    return await this._request('GET', `/comments?post_id=${postId}`, null, 'CreatePost');
  }
}