const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Constants
const SEA_DROP_ADDR = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const MULTIMINT_ADDR = "0x0000419B4B6132e05DfBd89F65B165DFD6fA126F";
const SUPPORTED_CHAIN_IDS = [1, 10, 42161, 8453, 143, 137, 2741, 43114, 80094, 999, 33139]; // Added ApeChain

// Chain names for display
const CHAIN_NAMES = {
    1: "Ethereum",
    10: "Optimism",
    42161: "Arbitrum",
    8453: "Base",
    143: "Monad",
    137: "Polygon",
    2741: "Metis",
    43114: "Avalanche",
    80094: "Berachain",
    999: "Hyperliquid",
    33139: "ApeChain"
};

// Minimal ABIs (only what's needed)
const SEA_ABI = [
    {
        "inputs": [{"internalType": "address", "name": "nftContract", "type": "address"}],
        "name": "getPublicDrop",
        "outputs": [{
            "components": [
                {"internalType": "uint80", "name": "mintPrice", "type": "uint80"},
                {"internalType": "uint48", "name": "startTime", "type": "uint48"},
                {"internalType": "uint48", "name": "endTime", "type": "uint48"},
                {"internalType": "uint16", "name": "maxTotalMintableByWallet", "type": "uint16"},
                {"internalType": "uint16", "name": "feeBps", "type": "uint16"},
                {"internalType": "bool", "name": "restrictFeeRecipients", "type": "bool"}
            ],
            "internalType": "struct PublicDrop",
            "name": "",
            "type": "tuple"
        }],
        "stateMutability": "view",
        "type": "function"
    }
];

const MULTI_ABI = [
    {
        "inputs": [
            {"internalType": "uint256", "name": "total", "type": "uint256"},
            {"internalType": "address", "name": "nftaddress", "type": "address"}
        ],
        "name": "mintMulti",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    }
];

// Symbol map for native token display
const SYMBOLS = {
    1: "ETH", 10: "ETH", 42161: "ETH", 8453: "ETH",
    137: "POL", 43114: "AVAX", 143: "MON", 2741: "ETH",
    80094: "BERA", 999: "HYPE", 33139: "APE" // Added ApeChain symbol
};

// Spinner class for loading animation
class Spinner {
    constructor(message = '') {
        this.message = message;
        this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.currentFrame = 0;
        this.intervalId = null;
    }

    start() {
        process.stdout.write('\x1b[?25l'); // Hide cursor
        this.intervalId = setInterval(() => {
            process.stdout.write(`\r${this.frames[this.currentFrame]} ${this.message}`);
            this.currentFrame = (this.currentFrame + 1) % this.frames.length;
        }, 100);
    }

    stop(finalMessage = '') {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        process.stdout.write('\r\x1b[K'); // Clear line
        if (finalMessage) {
            process.stdout.write(finalMessage + '\n');
        }
        process.stdout.write('\x1b[?25h'); // Show cursor
    }
}

// Helper function to ask questions
function askQuestion(query) {
    return new Promise(resolve => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(query, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

// Helper functions
function toChecksumAddress(address) {
    return ethers.utils.getAddress(address);
}

async function parseGasPriceGweiInput(input, provider) {
    try {
        if (!input || input.trim() === "") {
            const gasPrice = await provider.getGasPrice();
            return gasPrice.mul(12).div(10); // 1.2x
        }
        
        const s = input.trim().toLowerCase().replace("gwei", "").trim();
        const gweiValue = parseFloat(s);
        return ethers.utils.parseUnits(gweiValue.toString(), "gwei");
    } catch (e) {
        console.log("⚠️ Invalid gas price input; falling back to node gas price * 1.2. Error:", e);
        const gasPrice = await provider.getGasPrice();
        return gasPrice.mul(12).div(10); // 1.2x
    }
}

function gweiFromWei(wei) {
    return parseFloat(ethers.utils.formatUnits(wei, "gwei"));
}

async function signSendWait(provider, wallet, tx, timeout = 600000) {
    try {
        if (!tx.nonce) {
            tx.nonce = await provider.getTransactionCount(wallet.address);
        }
        if (!tx.chainId) {
            const network = await provider.getNetwork();
            tx.chainId = network.chainId;
        }
        
        const spinner = new Spinner("⏳ Sending transaction...");
        spinner.start();
        
        const txResponse = await wallet.sendTransaction(tx);
        spinner.stop(`✅ Sent Tx: ${txResponse.hash}`);
        
        const waitSpinner = new Spinner("⏳ Waiting for transaction confirmation...");
        waitSpinner.start();
        
        const receipt = await txResponse.wait(timeout);
        waitSpinner.stop(`✅ Transaction confirmed!`);
        
        return receipt;
    } catch (e) {
        throw e;
    }
}

// Function to load private key from file
function loadPrivateKey() {
    try {
        const privateKey = fs.readFileSync(path.join(__dirname, "pk.txt"), "utf8").trim();
        if (!privateKey) {
            throw new Error("Private key is empty");
        }
        return privateKey;
    } catch (error) {
        console.error("❌ Error reading private key from pk.txt:", error.message);
        return null;
    }
}

// Function to load RPCs from JSON file
function loadRPCs() {
    try {
        const rpcData = fs.readFileSync(path.join(__dirname, "rpc.json"), "utf8");
        return JSON.parse(rpcData);
    } catch (error) {
        console.error("❌ Error loading RPCs:", error);
        return {};
    }
}

// Function to get provider with fallback RPCs
async function getProviderWithFallback(chainId) {
    const rpcs = loadRPCs();
    const chainRPCs = rpcs[chainId];
    
    if (!chainRPCs || !Array.isArray(chainRPCs) || chainRPCs.length === 0) {
        throw new Error(`No RPCs configured for chain ID ${chainId}`);
    }
    
    // Try each RPC in order
    for (const rpcUrl of chainRPCs) {
        try {
            const spinner = new Spinner(`🔌 Connecting to RPC: ${rpcUrl.substring(0, 50)}...`);
            spinner.start();
            
            const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
            // Test the connection
            await provider.getNetwork();
            
            spinner.stop(`✅ Connected to RPC: ${rpcUrl.substring(0, 50)}...`);
            return provider;
        } catch (error) {
            spinner.stop(`❌ Failed to connect to RPC: ${error.message}`);
        }
    }
    
    throw new Error(`All RPCs failed for chain ID ${chainId}`);
}

// Function to display supported chains and let user choose
async function selectChain() {
    console.log("\n🌐 Supported chains:");
    SUPPORTED_CHAIN_IDS.forEach(id => {
        console.log(`  ${id}: ${CHAIN_NAMES[id]} (${SYMBOLS[id]})`);
    });
    
    const input = await askQuestion("\n🔍 Select chain by ID or name (leave blank for auto-detect): ");
    
    if (!input.trim()) {
        return null; // Auto-detect
    }
    
    // Try to parse as number first
    const chainId = parseInt(input);
    if (!isNaN(chainId) && SUPPORTED_CHAIN_IDS.includes(chainId)) {
        return chainId;
    }
    
    // Try to match by name (case insensitive)
    const lowerInput = input.toLowerCase();
    for (const [id, name] of Object.entries(CHAIN_NAMES)) {
        if (name.toLowerCase() === lowerInput) {
            return parseInt(id);
        }
    }
    
    console.log("❌ Invalid chain selection. Please try again.");
    return await selectChain();
}

// Main function
async function main() {
    try {
        console.log('\n🚀 Auto SeaDrop MultiMint V2 By ADFMID Team (Node.js Version)');
        console.log('=====================================\n');
        
        // Load private key from file
        const privateKey = loadPrivateKey();
        if (!privateKey) {
            return;
        }
        
        // Create wallet
        const wallet = new ethers.Wallet(privateKey);
        console.log(`👛 Using Address: ${wallet.address}\n`);
        
        // Let user select chain
        const selectedChainId = await selectChain();
        
        let chainId;
        let provider;
        
        if (selectedChainId !== null) {
            // User selected a specific chain
            chainId = selectedChainId;
            try {
                provider = await getProviderWithFallback(chainId);
            } catch (error) {
                console.error(`❌ Failed to connect to selected chain ${chainId}:`, error.message);
                return;
            }
        } else {
            // Auto-detect: try each supported chain until we find one that works
            console.log("🔍 Auto-detecting chain...");
            for (const id of SUPPORTED_CHAIN_IDS) {
                try {
                    provider = await getProviderWithFallback(id);
                    chainId = id;
                    break;
                } catch (error) {
                    console.warn(`⚠️ Failed to connect to chain ID ${id}:`, error.message);
                }
            }
            
            if (!provider || !chainId) {
                console.error("❌ Could not connect to any supported chain. Supported chain IDs:", SUPPORTED_CHAIN_IDS);
                return;
            }
        }
        
        console.log(`\n✅ Connected to chain: ${CHAIN_NAMES[chainId]} (ID: ${chainId})`);
        const native_symbol = SYMBOLS[chainId] || "ETH";
        
        // Connect wallet to provider
        const connectedWallet = wallet.connect(provider);
        
        // Contracts
        const sea_drop = toChecksumAddress(SEA_DROP_ADDR);
        const multimint = toChecksumAddress(MULTIMINT_ADDR);
        const seaContract = new ethers.Contract(sea_drop, SEA_ABI, provider);
        const multiContract = new ethers.Contract(multimint, MULTI_ABI, connectedWallet);
        
        // Gas price
        const gasInput = await askQuestion("\n⛽ Input Custom GWEI/Gas Price (0.01/1/10/100) Or Leave Blank [Default]: ");
        const gasPrice = await parseGasPriceGweiInput(gasInput, provider);
        console.log(`💨 Using Gas Price: ${gweiFromWei(gasPrice)} Gwei\n`);
        
        // Mint inputs
        const nftRaw = await askQuestion("🎨 Input NFT Contract Address: ");
        const nftAddr = toChecksumAddress(nftRaw);
        const total = parseInt(await askQuestion("🔢 Total Mint NFT: "));
        
        // Read price
        let price;
        try {
            const spinner = new Spinner("📊 Fetching NFT price...");
            spinner.start();
            
            const publicDrop = await seaContract.getPublicDrop(nftAddr);
            price = publicDrop.mintPrice;
            
            spinner.stop(`✅ Price fetched successfully!`);
        } catch (e) {
            console.log("❌ Failed Read Price From SeaDrop:", e);
            return;
        }
        
        const requiredTotalCost = price.mul(total);
        const priceNative = parseFloat(ethers.utils.formatUnits(price, "ether"));
        const totalNative = parseFloat(ethers.utils.formatUnits(requiredTotalCost, "ether"));
        console.log(`\n💰 Price Per Token: ${priceNative} ${native_symbol}`);
        console.log(`💸 Total Cost For ${total} NFTs: ${totalNative} ${native_symbol}\n`);
        
        const bal = await provider.getBalance(wallet.address);
        const balNative = parseFloat(ethers.utils.formatUnits(bal, "ether"));
        console.log(`👛 Wallet Balance: ${balNative} ${native_symbol}`);
        
        if (bal.lt(requiredTotalCost)) {
            console.log("❌ Not Enough Native Balance! Exiting...");
            return;
        }
        
        console.log("\n🚀 Starting minting process...\n");
        
        let attempt = 0;
        while (true) {
            attempt += 1;
            try {
                console.log(`🔄 Attempt #${attempt}: Building Mint TX...`);
                const value = requiredTotalCost;
                const nonce = await provider.getTransactionCount(wallet.address);
                
                // Estimate gas
                const spinner = new Spinner("⏳ Estimating gas...");
                spinner.start();
                
                const estimatedGas = await multiContract.estimateGas.mintMulti(total, nftAddr, { 
                    from: wallet.address, 
                    value: value 
                });
                
                spinner.stop(`✅ Estimated gas: ${estimatedGas.toString()}`);
                
                // Build transaction
                const tx = {
                    chainId: chainId,
                    from: wallet.address,
                    to: multimint,
                    value: value,
                    gasLimit: estimatedGas.mul(12).div(10), // 1.2x
                    gasPrice: gasPrice,
                    nonce: nonce,
                    data: multiContract.interface.encodeFunctionData("mintMulti", [total, nftAddr])
                };
                
                const receipt = await signSendWait(provider, connectedWallet, tx);
                console.log(`🎉 Mint Receipt Status: ${receipt.status === 1 ? 'SUCCESS ✅' : 'FAILED ❌'}`);
                
                if (receipt.status === 1) {
                    console.log(`🎊 Mint TX Succeeded: ${receipt.transactionHash}`);
                    console.log("\n🎉🎉🎉 CONGRATULATIONS! MINTING SUCCESSFUL! 🎉🎉🎉\n");
                    break;
                } else {
                    console.log("❌ Mint TX Failed Retrying...");
                    continue;
                }
            } catch (e) {
                console.log("❌ Mint Attempt Exception:", e);
                console.log("🔄 Retrying...");
                continue;
            }
        }
    } catch (e) {
        console.log("💥 Fatal Error:", e);
    }
}

main();
