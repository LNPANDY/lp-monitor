#!/bin/bash

# 测试移除仓位功能

echo "=== 测试移除仓位功能 ==="

# 1. 检查是否有未关闭的仓位
echo "1. 检查未关闭的仓位："
curl -s http://localhost:3000/api/positions | jq '.[] | {id: .id, token0_symbol: .token0_symbol, token1_symbol: .token1_symbol, notify_state: .notify_state}' | head -10

# 2. 检查特定仓位的状态（如果有具体的ID）
echo -e "\n2. 检查特定仓位的状态（示例ID=1）："
curl -s http://localhost:3000/api/positions/1 | jq '.'

# 3. 检查移除参数API（如果有具体ID）
echo -e "\n3. 检查移除参数API（示例ID=1）："
curl -s http://localhost:3000/api/positions/1/remove-params | jq '.'

# 4. 检查扫描状态
echo -e "\n4. 检查扫描状态："
curl -s http://localhost:3000/api/monitor/status | jq '.'

echo -e "\n=== 测试完成 ==="