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
            return base.then(gas => gas.mul(105).div(100)); // Hanya +5% dari default
        }
        
        const normalized = input.toLowerCase().replace("gwei", "").trim();
        const gweiValue = parseFloat(normalized);
        return ethers.utils.parseUnits(gweiValue.toString(), "gwei");
    } catch (e) {
        console.log(chalk.yellow("Invalid gas price input; falling back to node gas price + 5%"), e);
        const base = provider.getGasPrice();
        return base.then(gas => gas.mul(105).div(100)); // Hanya +5% dari default
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

// Fungsi untuk memeriksa status drop
function checkDropStatus(publicDrop) {
    const now = Math.floor(Date.now() / 1000);
    const startTime = publicDrop.startTime;
    const endTime = publicDrop.endTime;
    
    if (startTime > now) {
        return {
            valid: false,
            reason: "DROP_NOT_STARTED",
            message: `Drop hasn't started yet. Starts at: ${new Date(startTime * 1000).toLocaleString()}`,
            startTime: startTime
        };
    }
    
    if (endTime < now) {
        return {
            valid: false,
            reason: "DROP_ENDED",
            message: `Drop has already ended. Ended at: ${new Date(endTime * 1000).toLocaleString()}`
        };
    }
    
    return {
        valid: true,
        reason: "DROP_ACTIVE",
        message: "Drop is currently active"
    };
}

// Fungsi hybrid tricky mint
async function trickyMintHybrid(connectedWallet, multiContract, nftAddr, price, total, gasPrice, gasLimit, selectedChain, dropStatus) {
    console.log(chalk.yellow("\n=== HYBRID TRICKY MINT MODE ==="));
    console.log(chalk.white("Fast sending + selective confirmation checking"));
    console.log(chalk.white("========================\n"));
    
    let successCount = 0;
    let attemptCount = 0;
    const maxAttempts = total * 2;
    const pendingTxs = []; // Simpan tx yang pending
    
    // Progress bar
    const progressBar = new cliProgress.SingleBar({
        format: 'Hybrid Mint Progress |' + chalk.cyan('{bar}') + '| {percentage}% | {value}/{total} NFTs | Pending: {pending}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true
    });
    
    progressBar.start(total, 0, { pending: 0 });
    
    // Tunggu drop buka
    if (dropStatus.reason === "DROP_NOT_STARTED") {
        console.log(chalk.yellow(`Waiting for drop to open at ${new Date(dropStatus.startTime * 1000).toLocaleString()}...`));
        const waitSpinner = ora('Waiting for drop to open...').start();
        const waitTime = (dropStatus.startTime - Math.floor(Date.now() / 1000)) * 1000;
        if (waitTime > 0) await new Promise(resolve => setTimeout(resolve, waitTime));
        waitSpinner.succeed('Drop is now open! Starting mint...');
    }
    
    console.log(chalk.green("🚀 Rapid sending mode..."));
    
    // FASE 1: Kirim cepat tanpa konfirmasi
    while (successCount < total && attemptCount < maxAttempts) {
        attemptCount++;
        
        try {
            const tx = await multiContract.mintMulti(1, nftAddr, {
                value: price,
                gasPrice: gasPrice,
                gasLimit: gasLimit
            });
            
            console.log(chalk.green(`📤 Sent: ${tx.hash.substring(0, 10)}... (${attemptCount})`));
            pendingTxs.push({
                hash: tx.hash,
                index: attemptCount,
                checked: false
            });
            
            successCount++; // Asumsi berhasil dulu
            progressBar.update(successCount, { pending: pendingTxs.length });
            
            if (successCount >= total) break;
            
        } catch (e) {
            console.log(chalk.red(`❌ Failed: ${e.message}`));
        }
        
        await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay
    }
    
    console.log(chalk.yellow(`\n✅ Sent ${successCount} transactions! Checking confirmations...`));
    
    // FASE 2: Cek konfirmasi untuk pending txs
    let confirmedCount = 0;
    const checkInterval = setInterval(async () => {
        let stillPending = 0;
        
        for (let i = 0; i < pendingTxs.length; i++) {
            const tx = pendingTxs[i];
            if (tx.checked) continue;
            
            try {
                const receipt = await connectedWallet.provider.getTransactionReceipt(tx.hash);
                if (receipt) {
                    tx.checked = true;
                    if (receipt.status === 1) {
                        confirmedCount++;
                        console.log(chalk.green(`✅ Confirmed: ${tx.hash.substring(0, 10)}... (${confirmedCount})`));
                    } else {
                        console.log(chalk.red(`❌ Failed: ${tx.hash.substring(0, 10)}...`));
                    }
                } else {
                    stillPending++;
                }
            } catch (e) {
                stillPending++;
            }
        }
        
        progressBar.update(confirmedCount, { pending: stillPending });
        
        // Stop jika semua sudah dicek atau tidak ada pending lagi
        if (stillPending === 0 || confirmedCount === total) {
            clearInterval(checkInterval);
            progressBar.stop();
            
            console.log(chalk.green.bold(`\n🎉 Final Result: ${confirmedCount}/${successCount} transactions confirmed!`));
            
            if (confirmedCount < total) {
                console.log(chalk.yellow("Some transactions may still be pending. Check your wallet later."));
            }
        }
    }, 2000); // Cek setiap 2 detik
}

// Fungsi utama
async function main() {
    try {
        console.log(chalk.cyan.bold('Auto SeaDrop MultiMint V2 By ADFMID Team'));
        console.log(chalk.yellow.bold('HYBRID TRICKY MINT MODE - Fast + Reliable'));
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
            readline.question(chalk.blue('How many NFTs to mint per wallet? (recommended: 5-10): '), answer => {
                readline.close();
                resolve(answer.trim());
            });
        }));
        
        // Input gas price - dengan default yang lebih rendah
        const gasInput = await new Promise(resolve => {
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            readline.question(chalk.yellow('Input Custom GWEI/Gas Price (recommended: 0.3-1 for current network): '), answer => {
                readline.close();
                resolve(answer.trim());
            });
        });
        
        // Input gas limit - baru ditambahkan
        const gasLimitInput = await new Promise(resolve => {
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            readline.question(chalk.blue('Input Gas Limit (recommended: 150000, leave blank for default): '), answer => {
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
                
                // Periksa status drop
                const dropStatus = checkDropStatus(publicDrop);
                console.log(chalk.cyan(`Drop Status: ${dropStatus.message}`));
                
                const price = publicDrop.mintPrice;
                const priceNative = parseFloat(ethers.utils.formatEther(price));
                
                // Periksa apakah harga valid
                if (price.isZero()) {
                    console.log(chalk.yellow("Warning: NFT price is 0. This might be a free mint or an error."));
                }
                
                console.log(chalk.cyan(`Price Per Token: ${priceNative} ${selectedChain.symbol}`));
                console.log(chalk.cyan(`Max Mint Per Wallet: ${publicDrop.maxTotalMintableByWallet}`));
                
                // Cek balance tapi tidak hentikan proses
                const balance = await provider.getBalance(connectedWallet.address);
                const balanceNative = parseFloat(ethers.utils.formatEther(balance));
                
                console.log(chalk.cyan(`Wallet Balance: ${balanceNative} ${selectedChain.symbol}`));
                
                // Parse gas price
                const gasPrice = await parseGasPrice(gasInput, provider);
                const gasPriceGwei = parseFloat(ethers.utils.formatUnits(gasPrice, "gwei"));
                
                // Parse gas limit
                let gasLimit = 150000; // Default lebih rendah
                if (gasLimitInput && gasLimitInput.trim() !== "") {
                    gasLimit = parseInt(gasLimitInput);
                }
                
                // Hitung estimasi gas cost per transaksi
                const gasCostPerTx = parseFloat(ethers.utils.formatEther(gasPrice.mul(gasLimit)));
                const totalGasCost = gasCostPerTx * total;
                
                // Hitung total cost yang dibutuhkan
                const totalMintCost = priceNative * total;
                const totalNeeded = totalMintCost + totalGasCost;
                
                // Tampilkan peringatan jika balance tidak cukup, tapi lanjutkan proses
                if (balanceNative < totalNeeded) {
                    console.log(chalk.yellow(`Warning: Low balance! Need: ${totalNeeded.toFixed(6)} ${selectedChain.symbol}, Have: ${balanceNative.toFixed(6)} ${selectedChain.symbol}`));
                    console.log(chalk.yellow("Script will continue anyway, transactions may fail due to insufficient funds."));
                }
                
                console.log(chalk.cyan(`Gas Price: ${gasPriceGwei} Gwei`));
                console.log(chalk.cyan(`Gas Limit: ${gasLimit.toLocaleString()}`));
                
                // Tampilkan preview
                console.log(chalk.bold("\n=== MINT PREVIEW ==="));
                console.log(chalk.white(`NFT Contract: ${nftAddr}`));
                console.log(chalk.white(`Total Mint: ${total} NFTs`));
                console.log(chalk.white(`Price per NFT: ${priceNative} ${selectedChain.symbol}`));
                console.log(chalk.white(`Total Mint Fee: ${totalMintCost.toFixed(6)} ${selectedChain.symbol}`));
                console.log(chalk.white(`Gas Fee per Transaction: ${gasCostPerTx.toFixed(6)} ${selectedChain.symbol}`));
                console.log(chalk.white(`Total Gas Fee for ${total} Transactions: ${totalGasCost.toFixed(6)} ${selectedChain.symbol}`));
                console.log(chalk.white(`Total Needed: ${totalNeeded.toFixed(6)} ${selectedChain.symbol}`));
                console.log(chalk.white(`Gas Price: ${gasPriceGwei} Gwei`));
                console.log(chalk.white(`Gas Limit: ${gasLimit.toLocaleString()}`));
                console.log(chalk.white(`Wallet: ${connectedWallet.address}`));
                console.log(chalk.white(`Mode: Hybrid Tricky Mint (Fast + Reliable)`));
                console.log(chalk.bold("==================\n"));
                
                // Konfirmasi
                const confirm = await new Promise(resolve => {
                    const readline = require('readline').createInterface({
                        input: process.stdin,
                        output: process.stdout
                    });
                    readline.question(chalk.yellow('Proceed with hybrid tricky mint? (y/n): '), answer => {
                        readline.close();
                        resolve(answer.trim().toLowerCase());
                    });
                });
                
                if (confirm !== 'y') {
                    console.log(chalk.yellow("Mint cancelled by user"));
                    continue;
                }
                
                // Proses hybrid tricky mint
                await trickyMintHybrid(connectedWallet, multiContract, nftAddr, price, total, gasPrice, gasLimit, selectedChain, dropStatus);
                
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
