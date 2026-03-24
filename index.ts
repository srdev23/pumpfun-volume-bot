import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";

import {
  GLOBAL,
  FEE_RECIPIENT,
  SYSTEM_PROGRAM_ID,
  RENT,
  PUMP_FUN_ACCOUNT,
  PUMP_FUN_PROGRAM,
  ASSOC_TOKEN_ACC_PROG,
} from "./src/constants";

import { JitoBundleService, tipAccounts } from "./src/jito.bundle";
import {
  bufferFromUInt64,
  chunkArray,
  readBigUintLE,
  sleepTime,
} from "./src/utils";
import {
  CA,
  connection,
  DistributeAmount,
  JitoTipAmount,
  userKeypair,
} from "./src/config";
import fs from "fs";
import base58 from "bs58";

const WALLETS_JSON = "wallets.json";
const LUT_JSON = "./lut.json";

const FEE_ATA = 2039280;

class PumpfunVbot {
  slippage: number;
  mint: PublicKey;
  bondingCurve!: PublicKey;
  associatedBondingCurve!: PublicKey;
  virtualTokenReserves!: number;
  virtualSolReserves!: number;
  keypairs!: Keypair[];
  jitoBundleInstance: JitoBundleService;
  lookupTableAccount!: AddressLookupTableAccount;

  constructor(CA: string) {
    this.slippage = 0.5;
    this.mint = new PublicKey(CA);
    this.jitoBundleInstance = new JitoBundleService();
  }

  async getPumpData() {
    console.log("\n- Getting pump data...");
    const mint_account = this.mint.toBuffer();
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint_account],
      PUMP_FUN_PROGRAM
    );
    this.bondingCurve = bondingCurve;
    const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
      [
        bondingCurve.toBuffer(),
        spl.TOKEN_PROGRAM_ID.toBuffer(),
        this.mint.toBuffer(),
      ],
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );
    this.associatedBondingCurve = associatedBondingCurve;
    const PUMP_CURVE_STATE_OFFSETS = {
      VIRTUAL_TOKEN_RESERVES: 0x08,
      VIRTUAL_SOL_RESERVES: 0x10,
    };

    const response = await connection.getAccountInfo(bondingCurve);
    if (response === null) throw new Error("curve account not found");
    this.virtualTokenReserves = readBigUintLE(
      response.data,
      PUMP_CURVE_STATE_OFFSETS.VIRTUAL_TOKEN_RESERVES,
      8
    );
    this.virtualSolReserves = readBigUintLE(
      response.data,
      PUMP_CURVE_STATE_OFFSETS.VIRTUAL_SOL_RESERVES,
      8
    );
  }

  createWallets(total = 20) {
    const pks = [];
    for (let i = 0; i < total; i++) {
      const wallet = Keypair.generate();
      pks.push(base58.encode(wallet.secretKey));
    }
    fs.writeFileSync(WALLETS_JSON, JSON.stringify(pks, null, 2));
  }
  loadWallets(total = 20) {
    const keypairs = [];
    const wallets = JSON.parse(fs.readFileSync(WALLETS_JSON, "utf8"));
    for (const wallet of wallets) {
      const keypair = Keypair.fromSecretKey(base58.decode(wallet));
      keypairs.push(keypair);
      // console.log({ wallet: keypair.publicKey.toBase58() });
      if (keypairs.length >= total) break;
    }

    if(keypairs.length <= 0) throw new Error("Not wallets");
    console.log(`- ${keypairs.length} wallets are loaded`);
    this.keypairs = keypairs;
  }

  async collectSOL() {
    const chunkedKeypairs = chunkArray(this.keypairs, 8);
    const rawTxns = [];
    for(let i = 0; i < chunkedKeypairs.length; i++){
      const keypairs = chunkedKeypairs[i];
      const instructions: TransactionInstruction[] = [];
      const isLastTxn = i === chunkedKeypairs.length - 1;
      for (const keypair of keypairs) {
        const solBalance = await connection.getBalance(keypair.publicKey);
        const transferIns = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: userKeypair.publicKey,
          lamports: solBalance,
        });
        instructions.push(transferIns);
      }
      if(isLastTxn){
        const jitoTipIns = SystemProgram.transfer({
          fromPubkey: userKeypair.publicKey,
          toPubkey: new PublicKey(tipAccounts[0]),
          lamports: JitoTipAmount,
        });
        instructions.push(jitoTipIns);
      }
      const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

      const messageV0 = new TransactionMessage({
        payerKey: userKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      // }).compileToV0Message();
      }).compileToV0Message([this.lookupTableAccount]);

      const vTxn = new VersionedTransaction(messageV0);
      vTxn.sign([...keypairs, userKeypair]);
      const rawTxn = vTxn.serialize();
      console.log("Txn length:", rawTxn.length);
      if(rawTxn.length > 1232)
        throw new Error("Transaction too large");
      const { value: simulatedTransactionResponse } =
        await connection.simulateTransaction(vTxn);
      const { err, logs } = simulatedTransactionResponse;

      console.log("🚀 Simulate ~", Date.now());
      if (err) {
        console.error({ err, logs });
        throw new Error(`Simulation Failed`);
      }
      rawTxns.push(rawTxn);
    }
    const bundleId = await this.jitoBundleInstance.sendBundle(rawTxns);
    await this.jitoBundleInstance.getBundleStatus(bundleId);
  }

  async distributeSOL() {
    if (DistributeAmount <= FEE_ATA) {
      console.log(
        `Distribute SOL amount should be larger than ${(
          (FEE_ATA) /
          LAMPORTS_PER_SOL
        ).toFixed(3)} SOL`
      );
      process.exit(1);
    }

    const totalSolRequired: number = DistributeAmount * this.keypairs.length;

    const solBal = await connection.getBalance(userKeypair.publicKey);
    if (solBal < totalSolRequired) {
      console.log(
        `Insufficient SOL balance: ${(
          totalSolRequired / LAMPORTS_PER_SOL
        ).toFixed(3)}/${solBal / LAMPORTS_PER_SOL} SOL`
      );
      process.exit(1);
    }

    const instructions: TransactionInstruction[] = [];
    for (const keypair of this.keypairs) {
      const transferIns = SystemProgram.transfer({
        fromPubkey: userKeypair.publicKey,
        toPubkey: keypair.publicKey,
        lamports: DistributeAmount,
      });
      instructions.push(transferIns);
    }
    const jitoTipIns = SystemProgram.transfer({
      fromPubkey: userKeypair.publicKey,
      toPubkey: new PublicKey(tipAccounts[0]),
      lamports: JitoTipAmount,
    });
    instructions.push(jitoTipIns);
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const messageV0 = new TransactionMessage({
      payerKey: userKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions,
    // }).compileToV0Message();
    }).compileToV0Message([this.lookupTableAccount]);

    const vTxn = new VersionedTransaction(messageV0);
    vTxn.sign([userKeypair]);
    const rawTxn = vTxn.serialize();
    console.log("Txn length:", rawTxn.length);
    if(rawTxn.length > 1232)
      throw new Error("Transaction too large");
    const { value: simulatedTransactionResponse } =
      await connection.simulateTransaction(vTxn);
    const { err, logs } = simulatedTransactionResponse;

    console.log("🚀 Simulate ~", Date.now());

    if (err) {
      console.error({ err, logs });
      throw new Error(`Simulation Failed`);
    }
    const bundleId = await this.jitoBundleInstance.sendBundle([rawTxn]);
    await this.jitoBundleInstance.getBundleStatus(bundleId);
  }

  async createLUT() {
    try {
      console.log("\n- Creating new lookup table...");
      const createLUTixs: TransactionInstruction[] = [];
      const [createTi, lut] = AddressLookupTableProgram.createLookupTable({
        authority: userKeypair.publicKey,
        payer: userKeypair.publicKey,
        recentSlot: await connection.getSlot("finalized"),
      });

      const jitoTipIns = SystemProgram.transfer({
        fromPubkey: userKeypair.publicKey,
        toPubkey: new PublicKey(tipAccounts[0]),
        lamports: JitoTipAmount,
      });

      createLUTixs.push(createTi, jitoTipIns);
      const { blockhash } = await connection.getLatestBlockhash();

      const messageV0 = new TransactionMessage({
        payerKey: userKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: createLUTixs,
      }).compileToV0Message();

      const vTxn = new VersionedTransaction(messageV0);
      vTxn.sign([userKeypair]);
      const rawTxn = vTxn.serialize();
      console.log("Txn length:", rawTxn.length);
      if(rawTxn.length > 1232)
        throw new Error("Transaction too large");
      const { value: simulatedTransactionResponse } =
        await connection.simulateTransaction(vTxn);
      const { err, logs } = simulatedTransactionResponse;

      console.log("🚀 Simulate ~", Date.now());

      if (err) {
        console.error({ err, logs });
        throw new Error(`Simulation Failed`);
      }
      const bundleId = await this.jitoBundleInstance.sendBundle([rawTxn]);
      const success = await this.jitoBundleInstance.getBundleStatus(bundleId);
      if (success) fs.writeFileSync(LUT_JSON, JSON.stringify(lut));
    } catch (e) {
      console.error("Error creating LUT", e);
    }
  }

  async extendLUT() {
    try {
      console.log("\n- Extending lookup table...");
      const lut = JSON.parse(fs.readFileSync(LUT_JSON, "utf8"));
      console.log({ lut });
      const LUTpubkey = new PublicKey(lut);
      const PK_Array = JSON.parse(fs.readFileSync(WALLETS_JSON, "utf8"));
      console.log({ PK_Array: PK_Array.length });

      const ataTokenpayer = await spl.getAssociatedTokenAddress(
        this.mint,
        userKeypair.publicKey
      );
      const ataWSOLpayer = await spl.getAssociatedTokenAddress(
        spl.NATIVE_MINT,
        userKeypair.publicKey
      );

      const accounts: PublicKey[] = [
        LUTpubkey,
        userKeypair.publicKey,
        ataTokenpayer,
        ataWSOLpayer,
        this.mint,
        this.bondingCurve,
        this.associatedBondingCurve,
        RENT,
        GLOBAL,
        FEE_RECIPIENT,
        SYSTEM_PROGRAM_ID,
        ASSOC_TOKEN_ACC_PROG,
        spl.TOKEN_PROGRAM_ID,
        PUMP_FUN_ACCOUNT,
        PUMP_FUN_PROGRAM,
      ];
      for (const pk of PK_Array) {
        const keypair = Keypair.fromSecretKey(base58.decode(pk));
        const ataToken = await spl.getAssociatedTokenAddress(
          this.mint,
          keypair.publicKey
        );
        const ataWSOL = await spl.getAssociatedTokenAddress(
          spl.NATIVE_MINT,
          keypair.publicKey
        );
        accounts.push(keypair.publicKey, ataToken, ataWSOL);
      }

      const { blockhash } = await connection.getLatestBlockhash();

      const rawTxns: Uint8Array[] = [];
      const accountChunks = chunkArray(accounts, 30);
      for (let i = 0; i < accountChunks.length; i++) {
        const chunk = accountChunks[i];
        const extendIx = AddressLookupTableProgram.extendLookupTable({
          lookupTable: LUTpubkey,
          authority: userKeypair.publicKey,
          payer: userKeypair.publicKey,
          addresses: chunk,
        });

        const instructions: TransactionInstruction[] = [extendIx];
        if (i === accountChunks.length - 1) {
          instructions.push(
            SystemProgram.transfer({
              fromPubkey: userKeypair.publicKey,
              toPubkey: new PublicKey(tipAccounts[0]),
              lamports: JitoTipAmount,
            })
          );
        }

        const messageV0 = new TransactionMessage({
          payerKey: userKeypair.publicKey,
          recentBlockhash: blockhash,
          instructions: instructions,
        }).compileToV0Message();

        const vTxn = new VersionedTransaction(messageV0);
        vTxn.sign([userKeypair]);
        const rawTxn = vTxn.serialize();
        console.log("Txn length:", rawTxn.length);
        if(rawTxn.length > 1232)
          throw new Error("Transaction too large");
        const { value: simulatedTransactionResponse } =
          await connection.simulateTransaction(vTxn);
        const { err, logs } = simulatedTransactionResponse;

        console.log("🚀 Simulate ~", Date.now());

        if (err) {
          console.error({ err, logs });
          throw new Error(`Simulation Failed`);
        }
        rawTxns.push(rawTxn);
      }
      // Send bundle
      const bundleId = await this.jitoBundleInstance.sendBundle(rawTxns);
      await this.jitoBundleInstance.getBundleStatus(bundleId);
    } catch (e) {
      console.error("Error extending LUT", e);
      await sleepTime(3000);
      await this.extendLUT();
    }
  }

  async loadLUT() {
    const lut = JSON.parse(fs.readFileSync(LUT_JSON, "utf8"));
    console.log({ lut });
    const LUTpubkey = new PublicKey(lut);

    const lookupTableAccount = (
      await connection.getAddressLookupTable(LUTpubkey)
    ).value;

    
    if (lookupTableAccount == null) {
      console.error("Lookup table account not found!");
      process.exit(1);
    }
    this.lookupTableAccount = lookupTableAccount;
  }

  async swap() {
    try {
      console.log("\n- BUY/SELL...");
      const { blockhash } = await connection.getLatestBlockhash();

      const chunkedKeypairs = chunkArray(this.keypairs, 4);
      const rawTxns: Uint8Array[] = [];
      for (let i = 0; i < chunkedKeypairs.length; i++) {
        const keypairs = chunkedKeypairs[i];
        const isLastChunk = i === chunkedKeypairs.length - 1;
        const instructions: TransactionInstruction[] = [];
        const payerKeyId = Math.floor(Math.random() * keypairs.length);
        const payerKey = keypairs[payerKeyId];
        for (const keypair of keypairs) {
          const tokenATA = spl.getAssociatedTokenAddressSync(
            this.mint,
            keypair.publicKey,
            true
          );
          const buyKeys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: this.mint, isSigner: false, isWritable: false },
            { pubkey: this.bondingCurve, isSigner: false, isWritable: true },
            {
              pubkey: this.associatedBondingCurve,
              isSigner: false,
              isWritable: true,
            },
            { pubkey: tokenATA, isSigner: false, isWritable: true },
            { pubkey: keypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            {
              pubkey: spl.TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false,
            },
            { pubkey: RENT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
          ];

          const sellKeys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: this.mint, isSigner: false, isWritable: false },
            { pubkey: this.bondingCurve, isSigner: false, isWritable: true },
            {
              pubkey: this.associatedBondingCurve,
              isSigner: false,
              isWritable: true,
            },
            { pubkey: tokenATA, isSigner: false, isWritable: true },
            { pubkey: keypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            {
              pubkey: ASSOC_TOKEN_ACC_PROG,
              isSigner: false,
              isWritable: false,
            },
            {
              pubkey: spl.TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false,
            },
            { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
          ];
          const solBalance = await connection.getBalance(keypair.publicKey);
          const solAmount = Math.floor(
            Math.random() *
              (keypair.publicKey.toBase58() === payerKey.publicKey.toBase58()
                ? solBalance - FEE_ATA - JitoTipAmount * 2
                : solBalance - FEE_ATA)
          );

          if(solAmount <= 0)
            continue;

          console.log(
            ` .swap ${solAmount / LAMPORTS_PER_SOL}/ ${
              solBalance / LAMPORTS_PER_SOL
            } SOL`
          );
          const tokenOut = Math.floor(
            (solAmount * this.virtualTokenReserves) / this.virtualSolReserves
          );
          const solInWithSlippage = solAmount * (1 + this.slippage);
          const maxSolCost = Math.floor(solInWithSlippage);

          const buyData = Buffer.concat([
            bufferFromUInt64("16927863322537952870"),
            bufferFromUInt64(tokenOut),
            bufferFromUInt64(maxSolCost),
          ]);
          const minSolOutput = Math.floor(
            (tokenOut * (1 - this.slippage) * this.virtualSolReserves) /
              this.virtualTokenReserves
          );
          const sellData = Buffer.concat([
            bufferFromUInt64("12502976635542562355"),
            bufferFromUInt64(tokenOut),
            bufferFromUInt64(minSolOutput),
          ]);

          const buyInstruction = new TransactionInstruction({
            keys: buyKeys,
            programId: PUMP_FUN_PROGRAM,
            data: buyData,
          });

          const sellInstruction = new TransactionInstruction({
            keys: sellKeys,
            programId: PUMP_FUN_PROGRAM,
            data: sellData,
          });

          const subIns: TransactionInstruction[] = [
            spl.createAssociatedTokenAccountIdempotentInstruction(
              keypair.publicKey,
              tokenATA,
              keypair.publicKey,
              new PublicKey(this.mint)
            ),
            buyInstruction,
            sellInstruction,
            spl.createCloseAccountInstruction(
              tokenATA,
              keypair.publicKey,
              keypair.publicKey
            ),
          ];
          instructions.push(...subIns);
        }

        if (isLastChunk)
          instructions.push(
            SystemProgram.transfer({
              fromPubkey: payerKey.publicKey,
              toPubkey: new PublicKey(tipAccounts[0]),
              lamports: JitoTipAmount,
            })
          );
        const messageV0 = new TransactionMessage({
          payerKey: payerKey.publicKey,
          recentBlockhash: blockhash,
          instructions,
        // }).compileToV0Message();
        }).compileToV0Message([this.lookupTableAccount]);

        const vTxn = new VersionedTransaction(messageV0);
        vTxn.sign([...keypairs]);
        const rawTxn = vTxn.serialize();
        rawTxns.push(rawTxn);
        console.log("Txn length:", rawTxn.length);
        if(rawTxn.length > 1232)
          throw new Error("Transaction too large");
          
        const { value: simulatedTransactionResponse } =
          await connection.simulateTransaction(vTxn);
        const { err, logs } = simulatedTransactionResponse;

        console.log("🚀 Simulate ~", Date.now());

        if (err) {
          console.error({ err, logs });
          throw new Error(`Simulation Failed`);
        }
      }

      const bundleId = await this.jitoBundleInstance.sendBundle(rawTxns);
      await this.jitoBundleInstance.getBundleStatus(bundleId);
    } catch (error) {
      console.error(`Error during transaction: ${error}`);
    }
  }
}

(async () => {
  const pumpBot = new PumpfunVbot(CA);
  await pumpBot.getPumpData();
  // pumpBot.createWallets(); // Optional for creating new 20 wallets
  pumpBot.loadWallets();
  await pumpBot.createLUT();
  await pumpBot.extendLUT();
  await pumpBot.loadLUT();
  // await pumpBot.distributeSOL(); // Optional for distributing sol to 20 wallets
  while(true){
    await pumpBot.swap();
    await sleepTime(3000);
  }
  // await pumpBot.collectSOL(); // Optional for collecting sol to main wallet
})();
