"""
NexusGenesis - 抗量子钱包 (Python 版本)
统一地址格式：与 JS 版本兼容

算法：CRYSTALS-Dilithium2
地址格式：ng1 + Base58(1 字节版本 + 20 字节公钥哈希 + 4 字节校验和)
"""

import oqs
import hashlib
import base58
import binascii
import os

# 地址常量
ADDRESS_VERSION = 0x00
ADDRESS_PREFIX = 'ng1'
PAYLOAD_SIZE = 20
CHECKSUM_SIZE = 4


def sha3_256(data: bytes) -> bytes:
    """SHA3-256 哈希"""
    return hashlib.sha3_256(data).digest()


def base58_encode(data: bytes) -> str:
    """Base58 编码"""
    return base58.b58encode(data).decode('utf-8')


def base58_decode(encoded: str) -> bytes:
    """Base58 解码"""
    return base58.b58decode(encoded)


def generate_address(public_key: bytes) -> str:
    """
    从公钥生成地址 (与 JS 版本兼容)
    
    步骤:
    1. SHA3-256 哈希公钥
    2. 截取前 20 字节
    3. 添加版本前缀 (0x00)
    4. 计算校验和 (SHA3-256 前 4 字节)
    5. Base58 编码 + ng1 前缀
    """
    # Step 1: SHA3-256 哈希公钥
    pub_key_hash = sha3_256(public_key)
    
    # Step 2: 截取前 20 字节
    payload = pub_key_hash[:PAYLOAD_SIZE]
    
    # Step 3: 添加版本前缀
    versioned_payload = bytes([ADDRESS_VERSION]) + payload
    
    # Step 4: 计算校验和 (SHA3-256)
    checksum_hash = sha3_256(versioned_payload)
    checksum = checksum_hash[:CHECKSUM_SIZE]
    
    # Step 5: 拼接 + Base58 编码
    final_bytes = versioned_payload + checksum
    encoded = base58_encode(final_bytes)
    
    return ADDRESS_PREFIX + encoded


def validate_address(address: str) -> dict:
    """
    验证地址格式是否正确
    
    Returns:
        dict: {'valid': bool, 'reason': str (optional)}
    """
    # 检查前缀
    if not address.startswith(ADDRESS_PREFIX):
        return {'valid': False, 'reason': 'Invalid prefix, expected ng1'}
    
    # 解码 Base58
    encoded = address[len(ADDRESS_PREFIX):]
    try:
        decoded = base58_decode(encoded)
    except Exception as e:
        return {'valid': False, 'reason': f'Invalid Base58 encoding: {e}'}
    
    # 检查长度：1 (版本) + 20 (公钥哈希) + 4 (校验和) = 25 字节
    expected_length = 1 + PAYLOAD_SIZE + CHECKSUM_SIZE
    if len(decoded) != expected_length:
        return {'valid': False, 'reason': f'Invalid length: expected {expected_length} bytes, got {len(decoded)}'}
    
    # 验证版本
    version = decoded[0]
    if version != ADDRESS_VERSION:
        return {'valid': False, 'reason': f'Invalid version: expected {ADDRESS_VERSION}, got {version}'}
    
    # 验证校验和
    versioned_payload = decoded[:1 + PAYLOAD_SIZE]
    provided_checksum = decoded[1 + PAYLOAD_SIZE:]
    
    expected_checksum = sha3_256(versioned_payload)[:CHECKSUM_SIZE]
    
    if provided_checksum != expected_checksum:
        return {'valid': False, 'reason': 'Invalid checksum'}
    
    return {'valid': True}


def extract_pubkey_hash(address: str) -> bytes:
    """
    从地址提取 20 字节公钥哈希
    """
    result = validate_address(address)
    if not result['valid']:
        raise ValueError(f"Invalid address: {result.get('reason')}")
    
    encoded = address[len(ADDRESS_PREFIX):]
    decoded = base58_decode(encoded)
    
    # 跳过版本字节，返回 20 字节公钥哈希
    return decoded[1:1 + PAYLOAD_SIZE]


def create_observer_wallet():
    """生成观察者钱包"""
    print("--------------------------------------------------")
    print(">>> NexusGenesis 抗量子引擎 (CRYSTALS-Dilithium2)")
    print(">>> 地址格式：ng1 + Base58 (与 JS 版本兼容)")
    print("--------------------------------------------------")
    
    # 1. 生成抗量子密钥对
    sig = oqs.Signature("Dilithium2")
    public_key = sig.generate_keypair()
    secret_key = sig.export_secret_key()
    
    print(f"[✓] 密钥对生成完毕")
    print(f"    公钥长度：{len(public_key)} 字节")
    print(f"    私钥长度：{len(secret_key)} 字节")
    
    # 2. 生成地址
    address = generate_address(public_key)
    
    print(f"[✓] 地址生成完毕")
    print(f"    地址：{address}")
    
    # 3. 验证地址
    validation = validate_address(address)
    if validation['valid']:
        print(f"[✓] 地址验证通过")
    else:
        print(f"[✗] 地址验证失败：{validation.get('reason')}")
    
    # 4. 输出
    pk_hex = binascii.hexlify(public_key).decode()
    sk_hex = binascii.hexlify(secret_key).decode()
    
    print("\n==================================================")
    print(" NEXUS GENESIS 观察者创世钱包")
    print("==================================================")
    print(f" [1] 公开地址 (Public Address):")
    print(f"     {address}")
    print(f" [2] 抗量子公钥 (Public Key):")
    print(f"     {pk_hex[:64]}...")
    print(f" [3] 抗量子私钥 (Private Key) - [最高机密!]:")
    print(f"     {sk_hex}")
    print("==================================================")
    print("\n⚠️  警告：")
    print("    - 私钥控制资产，请离线保存")
    print("    - 切勿将私钥发送给任何人")
    print("    - 包括 OpenClaw 或其他 AI 系统")
    print("==================================================")
    
    return address, public_key, secret_key


if __name__ == "__main__":
    create_observer_wallet()
