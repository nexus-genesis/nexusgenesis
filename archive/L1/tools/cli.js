/**
 * NexusGenesis 命令行工具
 * 本地合约开发辅助工具
 */

import fs from 'fs/promises';
import path from 'path';
import sdk from '../src/sdk/index.js';

class CLI {
  constructor() {
    this.sdk = sdk;
  }

  /**
   * 显示帮助信息
   */
  showHelp() {
    console.log('NexusGenesis CLI 工具');
    console.log('====================');
    console.log('');
    console.log('说明: 该 CLI 仅面向本地合约开发与状态文件管理，不代表公网 bootstrap API 全部能力。');
    console.log('');
    console.log('命令列表:');
    console.log('  deploy <bytecode-file> <name> - 部署智能合约');
    console.log('  execute <contract-id> - 执行智能合约');
    console.log('  info <contract-id> - 获取合约信息');
    console.log('  list - 列出所有合约');
    console.log('  save <file-path> - 保存合约状态');
    console.log('  load <file-path> - 加载合约状态');
    console.log('  compile <source-file> <output-file> - 编译合约');
    console.log('  help - 显示帮助信息');
    console.log('');
  }

  /**
   * 部署合约
   * @param {string} bytecodeFile - 字节码文件路径
   * @param {string} name - 合约名称
   */
  async deploy(bytecodeFile, name) {
    try {
      const bytecode = JSON.parse(await fs.readFile(bytecodeFile, 'utf8'));
      const contractId = this.sdk.deployContract(bytecode, name);
      console.log(`合约部署成功，ID: ${contractId}`);
    } catch (error) {
      console.error('部署失败:', error.message);
    }
  }

  /**
   * 执行合约
   * @param {string} contractId - 合约ID
   */
  execute(contractId) {
    try {
      const result = this.sdk.executeContract(contractId);
      console.log('执行结果:', result);
    } catch (error) {
      console.error('执行失败:', error.message);
    }
  }

  /**
   * 获取合约信息
   * @param {string} contractId - 合约ID
   */
  info(contractId) {
    try {
      const info = this.sdk.getContractInfo(contractId);
      console.log('合约信息:', info);
    } catch (error) {
      console.error('获取信息失败:', error.message);
    }
  }

  /**
   * 列出所有合约
   */
  list() {
    try {
      const contracts = this.sdk.listContracts();
      console.log('合约列表:');
      contracts.forEach(contract => {
        console.log(`- ${contract.id} (${contract.name})`);
      });
    } catch (error) {
      console.error('列出合约失败:', error.message);
    }
  }

  /**
   * 保存合约状态
   * @param {string} filePath - 文件路径
   */
  async save(filePath) {
    try {
      await this.sdk.saveState(filePath);
      console.log(`状态保存成功: ${filePath}`);
    } catch (error) {
      console.error('保存失败:', error.message);
    }
  }

  /**
   * 加载合约状态
   * @param {string} filePath - 文件路径
   */
  async load(filePath) {
    try {
      await this.sdk.loadState(filePath);
      console.log(`状态加载成功: ${filePath}`);
    } catch (error) {
      console.error('加载失败:', error.message);
    }
  }

  /**
   * 编译合约
   * @param {string} sourceFile - 源文件路径
   * @param {string} outputFile - 输出文件路径
   */
  async compile(sourceFile, outputFile) {
    try {
      const source = await fs.readFile(sourceFile, 'utf8');
      const bytecode = this.sdk.compile(JSON.parse(source));
      await fs.writeFile(outputFile, JSON.stringify(bytecode, null, 2));
      console.log(`编译成功: ${outputFile}`);
    } catch (error) {
      console.error('编译失败:', error.message);
    }
  }

  /**
   * 运行命令
   * @param {Array} args - 命令参数
   */
  async run(args) {
    if (args.length === 0 || args[0] === 'help') {
      this.showHelp();
      return;
    }

    const command = args[0];
    const params = args.slice(1);

    switch (command) {
      case 'deploy':
        await this.deploy(params[0], params[1] || 'Unnamed Contract');
        break;
      case 'execute':
        this.execute(params[0]);
        break;
      case 'info':
        this.info(params[0]);
        break;
      case 'list':
        this.list();
        break;
      case 'save':
        await this.save(params[0]);
        break;
      case 'load':
        await this.load(params[0]);
        break;
      case 'compile':
        await this.compile(params[0], params[1]);
        break;
      default:
        console.log(`未知命令: ${command}`);
        this.showHelp();
    }
  }
}

// 运行CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = new CLI();
  cli.run(process.argv.slice(2));
}

export default CLI;
