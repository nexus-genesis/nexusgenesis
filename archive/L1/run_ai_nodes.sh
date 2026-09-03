#!/bin/bash
# NexusGenesis - 一键多节点启动脚本
# 功能：在本地启动多个 AI 节点，无需 Docker
# 使用：bash run_ai_nodes.sh [节点数量]

# 默认节点数量
if [ -z "$1" ]; then
    NODE_COUNT=3
else
    NODE_COUNT=$1
fi

# 验证节点数量范围
if [ $NODE_COUNT -lt 3 ]; then
    NODE_COUNT=3
fi
if [ $NODE_COUNT -gt 8 ]; then
    NODE_COUNT=8
fi

# 起始端口
START_PORT=9847

# 工作目录
WORK_DIR=$(pwd)
NODE_SCRIPT="$WORK_DIR/start-node.bat"

# 检查必要文件
if [ ! -f "$WORK_DIR/start-multi-nodes.js" ]; then
    echo "错误：找不到 start-multi-nodes.js 文件"
    exit 1
fi

# 显示启动信息
echo "========================================"
echo "NexusGenesis - 一键多节点启动"
echo "节点数量：$NODE_COUNT"
echo "起始端口：$START_PORT"
echo "工作目录：$WORK_DIR"
echo "========================================"
echo

# 清理之前的节点状态
echo "[1/3] 清理之前的节点状态..."
rm -rf "$WORK_DIR/data/state" 2>/dev/null
mkdir -p "$WORK_DIR/data/state" 2>/dev/null

echo "[2/3] 生成节点配置..."
# 生成节点配置文件
for ((i=1; i<=$NODE_COUNT; i++)); do
    PORT=$((START_PORT + i - 1))
    
    # 创建节点配置文件
    CONFIG_FILE="$WORK_DIR/data/state/node$i.json"
    cat > "$CONFIG_FILE" << EOF
{
  "nodeId": "nexus-node-$i",
  "port": $PORT,
  "status": "OFFLINE",
  "startTime": null,
  "peers": [],
  "balance": 10000000
}
EOF
    
    echo "生成节点 $i 配置：端口 $PORT"
done

echo
echo "[3/3] 启动节点..."
echo "注意：按 Ctrl+C 可以停止所有节点"
echo

# 启动节点
for ((i=1; i<=$NODE_COUNT; i++)); do
    PORT=$((START_PORT + i - 1))
    
    echo "启动节点 $i（端口 $PORT）..."
    # 在后台启动节点
    node "$WORK_DIR/start-multi-nodes.js" --count 1 --port $PORT &
    
    # 给节点一些启动时间
    sleep 2
done

echo
echo "========================================"
echo "所有节点已启动"
echo "请在各自的窗口中查看节点状态"
echo "按任意键退出..."
echo "========================================"

# 等待用户输入
read -n 1 -s
echo

# 清理后台进程
pkill -f "start-multi-nodes.js" 2>/dev/null
echo "所有节点已停止"
exit 0