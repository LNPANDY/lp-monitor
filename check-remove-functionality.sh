#!/bin/bash
# 检查移除仓位功能的所有必需文件

echo "检查移除仓位功能必需文件..."

# 核心组件文件
echo "1. 检查核心组件文件:"
if [ -f "src/components/remove-position-button.tsx" ]; then
    echo "✓ src/components/remove-position-button.tsx 存在"
else
    echo "✗ src/components/remove-position-button.tsx 不存在"
fi

# 钱包相关文件
echo "2. 检查钱包相关文件:"
if [ -f "src/lib/wallet/use-wallet.ts" ]; then
    echo "✓ src/lib/wallet/use-wallet.ts 存在"
else
    echo "✗ src/lib/wallet/use-wallet.ts 不存在"
fi

if [ -f "src/lib/wallet/provider.ts" ]; then
    echo "✓ src/lib/wallet/provider.ts 存在"
else
    echo "✗ src/lib/wallet/provider.ts 不存在"
fi

# 交易构建文件
echo "3. 检查交易构建文件:"
if [ -f "src/lib/wallet/build-multicall.ts" ]; then
    echo "✓ src/lib/wallet/build-multicall.ts 存在"
else
    echo "✗ src/lib/wallet/build-multicall.ts 不存在"
fi

if [ -f "src/lib/wallet/write-abi.ts" ]; then
    echo "✓ src/lib/wallet/write-abi.ts 存在"
else
    echo "✗ src/lib/wallet/write-abi.ts 不存在"
fi

# API端点文件
echo "4. 检查API端点文件:"
if [ -f "src/app/api/positions/[id]/remove-params/route.ts" ]; then
    echo "✓ src/app/api/positions/[id]/remove-params/route.ts 存在"
else
    echo "✗ src/app/api/positions/[id]/remove-params/route.ts 不存在"
fi

# 检查页面中是否正确导入
echo "5. 检查页面中的导入:"
if grep -q "RemovePositionButton" src/app/page.tsx; then
    echo "✓ page.tsx 中正确导入了 RemovePositionButton"
else
    echo "✗ page.tsx 中没有找到 RemovePositionButton 导入"
fi

# 检查PositionCard中是否使用
if grep -q "RemovePositionButton" src/app/page.tsx; then
    echo "✓ PositionCard 中使用了 RemovePositionButton"
else
    echo "✗ PositionCard 中没有使用 RemovePositionButton"
fi

echo "检查完成！"