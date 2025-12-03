const ethers = require('ethers');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const cliProgress = require('cli-progress');

// Konstanta
const SEA_DROP_ADDR = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const MULTIMINT_ADDR = "0x0000419B4B6132e05DfBd89F65B165DFD6fA126F";

// ABI Minimal
const SEA_ABI = [
    "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))"
];

const MULTI_ABI = [
    "function mintMulti(uint256 total, address nftaddress) payable"
];

// Fungsi utilitas
function toChecksumAddress(address) {
    return ethers.utils.getAddress(address);
}

function parseGasPrice(input, provider) {
    try {
        if (!input || input.trim() === "") {
            const base = provider.getGasPrice();
            return base.then(gas => gas.mul(120).div(100)); // +20%
        }
        
        const normalized = input.toLowerCase().replace("gwei", "").trim();
        const gweiValue = parseFloat(normalized);
        return ethers.utils.parseUnits(gweiValue.toString(), "gwei");
    } catch (e) {
        console.log(chalk.yellow("Invalid gas price input; falling back to node gas price * 1.2"), e);
        return provider.getGasPrice().then(gas => gas.mul(120).div(100));
    }
}

async function signSendWait(wallet, tx, provider) {
    try {
        if (!tx.nonce) {
            tx.nonce = await provider.getTransactionCount(wallet.address);
        }
        if (!tx.chainId) {
            tx.chainId = (await provider.getNetwork()).chainId;
        }
        
        const signedTx = await wallet.signTransaction(tx);
        const txHash = await provider.send("eth_sendRawTransaction", [signedTx]);
        
        console.log(chalk.blue(`Sent Tx: ${txHash}`));
        
        const spinner = ora('Waiting for transaction confirmation...').start();
        const receipt = await provider.waitForTransaction(txHash);
        spinner.succeed('Transaction confirmed!');
        
        return receipt;
    } catch (e) {
        throw e;
    }
}

// Fungsi untuk menampilkan daftar chain
function displayChainList(chains) {
    console.log(chalk.cyan("\nAvailable Chains:"));
    chains.forEach((chain, index) => {
        console.log(`${index + 1}. ${chain.name.toUpperCase()} (${chain.symbol})`);
    });
    console.log(`${chains.length + 1}. ADD NEW CHAIN`);
}

// Fungsi untuk menambah chain baru
async function addNewChain() {
    console.log(chalk.yellow("\n=== Add New Chain ==="));
    
    const chainId = await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question(chalk.blue('Enter Chain ID: '), answer => {
            readline.close();
            resolve(answer.trim());
        });
    });
    
    const name = await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question(chalk.blue('Enter Chain Name: '), answer => {
            readline.close();
            resolve(answer.trim());
        });
    });
    
    const symbol = await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question(chalk.blue('Enter Native Token Symbol: '), answer => {
            readline.close();
            resolve(answer.trim());
        });
    });
    
    const rpc1 = await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question(chalk.blue('Enter RPC URL 1: '), answer => {
            readline.close();
            resolve(answer.trim());
        });
    });
    
    const rpc2 = await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question(chalk.blue('Enter RPC URL 2: '), answer => {
            readline.close();
            resolve(answer.trim());
        });
    });
    
    return {
        chainId: parseInt(chainId),
        name,
        symbol,
        rpcs: [rpc1, rpc2]
    };
}

// Fungsi untuk memilih chain
async function selectChain(chains) {
    displayChainList(chains);
    
    const choice = await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question(chalk.blue('\nSelect chain option: '), answer => {
            readline.close();
            resolve(parseInt(answer.trim()));
        });
    });
    
    if (choice === chains.length + 1) {
        // Tambah chain baru
        const newChain = await addNewChain();
        chains.push(newChain);
        
        // Simpan ke file
        const rpcPath = path.join(__dirname, 'rpc.json');
        const rpcConfig = {};
        chains.forEach(chain => {
            rpcConfig[chain.chainId] = {
                name: chain.name,
                symbol: chain.symbol,
                rpcs: chain.rpcs
            };
        });
        fs.writeFileSync(rpcPath, JSON.stringify(rpcConfig, null, 2));
        
        console.log(chalk.green(`\n✅ Added new chain: ${newChain.name} (${newChain.chainId})`));
        return newChain;
    } else if (choice > 0 && choice <= chains.length) {
        return chains[choice - 1];
    } else {
        console.log(chalk.red("Invalid choice!"));
        return null;
    }
}

// Fungsi utama
async function main() {
    try {
        console.log(chalk.cyan.bold('OSMINT BY 0XZEPETO'));
        console.log("");
        
        // Baca private keys
        const pkPath = path.join(__dirname, 'pk.txt');
        if (!fs.existsSync(pkPath)) {
            console.log(chalk.red("pk.txt not found!"));
            return;
        }
        
        const privateKeys = fs.readFileSync(pkPath, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
            
        if (privateKeys.length === 0) {
            console.log(chalk.red("No private keys found in pk.txt!"));
            return;
        }
        
        console.log(chalk.green(`Loaded ${privateKeys.length} private key(s)`));
        
        // Baca RPC config
        const rpcPath = path.join(__dirname, 'rpc.json');
        if (!fs.existsSync(rpcPath)) {
            console.log(chalk.red("rpc.json not found!"));
            return;
        }
        
        const rpcConfig = JSON.parse(fs.readFileSync(rpcPath, 'utf8'));
        
        // Konversi ke array untuk ditampilkan
        let chains = [];
        for (const [chainId, chainInfo] of Object.entries(rpcConfig)) {
            chains.push({
                chainId: parseInt(chainId),
                name: chainInfo.name,
                symbol: chainInfo.symbol,
                rpcs: chainInfo.rpcs
            });
        }
        
        // Pilih chain
        let selectedChain = await selectChain(chains);
        if (!selectedChain) {
            console.log(chalk.red("No valid chain selected!"));
            return;
        }
        
        // Tampilkan selected chain dengan format yang diminta
        console.log(chalk.green(`\nSelected chain: ${selectedChain.name} (${selectedChain.chainId})`));
        
        // Input NFT dan jumlah mint
        const nftRaw = await new Promise(resolve => {
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            readline.question(chalk.blue('Input NFT Contract Address: '), answer => {
                readline.close();
                resolve(answer.trim());
            });
        });
        
        const nftAddr = toChecksumAddress(nftRaw);
        const total = parseInt(await new Promise(resolve => {
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            readline.question(chalk.blue('Total Mint NFT: '), answer => {
                readline.close();
                resolve(answer.trim());
            });
        }));
        
        // Input gas price
        const gasInput = await new Promise(resolve => {
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            readline.question(chalk.blue('Input Custom GWEI/Gas Price (0.01/1/10/100) Or Leave Blank [Default]: '), answer => {
                readline.close();
                resolve(answer.trim());
            });
        });
        
        // Proses setiap private key
        for (const pk of privateKeys) {
            console.log(chalk.yellow(`\nProcessing wallet: ${pk.substring(0, 6)}...${pk.substring(pk.length - 4)}`));
            
            // Buat wallet
            const wallet = new ethers.Wallet(pk);
            
            // Coba koneksi dengan RPC yang tersedia
            let connected = false;
            let provider;
            
            for (const rpc of selectedChain.rpcs) {
                try {
                    provider = new ethers.providers.JsonRpcProvider(rpc);
                    await provider.getNetwork();
                    connected = true;
                    console.log(chalk.green(`Connected to RPC: ${rpc}`));
                    break;
                } catch (e) {
                    console.log(chalk.red(`RPC ${rpc} failed: ${e.message}`));
                }
            }
            
            if (!connected) {
                console.log(chalk.red("All RPCs failed for this chain!"));
                continue;
            }
            
            // Connect wallet ke provider
            const connectedWallet = wallet.connect(provider);
            
            // Setup kontrak
            const seaDropContract = new ethers.Contract(SEA_DROP_ADDR, SEA_ABI, provider);
            const multiContract = new ethers.Contract(MULTIMINT_ADDR, MULTI_ABI, connectedWallet);
            
            // Dapatkan harga
            const spinner = ora('Fetching NFT price...').start();
            try {
                const publicDrop = await seaDropContract.getPublicDrop(nftAddr);
                spinner.succeed('Price fetched successfully!');
                
                const price = publicDrop.mintPrice;
                const priceNative = parseFloat(ethers.utils.formatEther(price));
                const totalNative = priceNative * total;
                
                console.log(chalk.cyan(`Price Per Token: ${priceNative} ${selectedChain.symbol}`));
                console.log(chalk.cyan(`Total Cost For ${total} NFTs: ${totalNative} ${selectedChain.symbol}`));
                
                // Cek balance
                const balance = await provider.getBalance(connectedWallet.address);
                const balanceNative = parseFloat(ethers.utils.formatEther(balance));
                
                console.log(chalk.cyan(`Wallet Balance: ${balanceNative} ${selectedChain.symbol}`));
                
                if (balance.lt(price.mul(total))) {
                    console.log(chalk.red("Not enough native balance!"));
                    continue;
                }
                
                // Parse gas price
                const gasPrice = await parseGasPrice(gasInput, provider);
                const gasPriceGwei = parseFloat(ethers.utils.formatUnits(gasPrice, "gwei"));
                
                // Estimasi gas
                const gasEstimate = await multiContract.estimateGas.mintMulti(total, nftAddr, {
                    value: price.mul(total)
                });
                
                const gasFee = gasPrice.mul(gasEstimate);
                const gasFeeNative = parseFloat(ethers.utils.formatEther(gasFee));
                
                // Tampilkan preview
                console.log(chalk.bold("\n=== MINT PREVIEW ==="));
                console.log(chalk.white(`NFT Contract: ${nftAddr}`));
                console.log(chalk.white(`Total Mint: ${total} NFTs`));
                console.log(chalk.white(`Price per NFT: ${priceNative} ${selectedChain.symbol}`));
                console.log(chalk.white(`Total Mint Fee: ${totalNative} ${selectedChain.symbol}`));
                console.log(chalk.white(`Gas Price: ${gasPriceGwei} Gwei`));
                console.log(chalk.white(`Estimated Gas Fee: ${gasFeeNative} ${selectedChain.symbol}`));
                console.log(chalk.white(`Total Cost: ${(totalNative + gasFeeNative).toFixed(6)} ${selectedChain.symbol}`));
                console.log(chalk.white(`Wallet: ${connectedWallet.address}`));
                console.log(chalk.bold("==================\n"));
                
                // Konfirmasi
                const confirm = await new Promise(resolve => {
                    const readline = require('readline').createInterface({
                        input: process.stdin,
                        output: process.stdout
                    });
                    readline.question(chalk.yellow('Proceed with mint? (y/n): '), answer => {
                        readline.close();
                        resolve(answer.trim().toLowerCase());
                    });
                });
                
                if (confirm !== 'y') {
                    console.log(chalk.yellow("Mint cancelled by user"));
                    continue;
                }
                
                // Proses mint
                const mintSpinner = ora('Preparing mint transaction...').start();
                
                try {
                    const tx = await multiContract.mintMulti(total, nftAddr, {
                        value: price.mul(total),
                        gasPrice: gasPrice,
                        gasLimit: gasEstimate.mul(120).div(100) // +20%
                    });
                    
                    mintSpinner.text = 'Sending transaction...';
                    
                    const receipt = await tx.wait();
                    
                    mintSpinner.succeed(chalk.green(`Mint successful! Tx: ${receipt.transactionHash}`));
                    
                    // Progress bar untuk visualisasi
                    const progressBar = new cliProgress.SingleBar({
                        format: 'Mint Progress |' + chalk.cyan('{bar}') + '| {percentage}% | {value}/{total} NFTs',
                        barCompleteChar: '\u2588',
                        barIncompleteChar: '\u2591',
                        hideCursor: true
                    });
                    
                    progressBar.start(total, 0);
                    
                    // Simulasi progress
                    for (let i = 1; i <= total; i++) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        progressBar.update(i);
                    }
                    
                    progressBar.stop();
                    console.log(chalk.green.bold(`\n✅ Successfully minted ${total} NFTs!`));
                    
                } catch (e) {
                    mintSpinner.fail(chalk.red(`Mint failed: ${e.message}`));
                    console.log(chalk.red(e));
                }
                
            } catch (e) {
                spinner.fail(chalk.red(`Failed to fetch price: ${e.message}`));
                console.log(chalk.red(e));
            }
        }
        
    } catch (e) {
        console.log(chalk.red("Fatal Error:"), e);
    }
}

// Jalankan
if (require.main === module) {
    main();
}
