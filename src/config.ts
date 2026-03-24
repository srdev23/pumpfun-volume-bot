import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import base58 from "bs58";
import dotenv from "dotenv";
dotenv.config();

export const RPC_URL = process.env.RPC_URL;
export const connection = new Connection(RPC_URL!, "confirmed");
export const userKeypair = Keypair.fromSecretKey(base58.decode(process.env.PRIVATE_KEY!)); // User main wallet

export const DistributeAmount = 0.01 * LAMPORTS_PER_SOL; // 0.01 SOL

export const JitoTipAmount = 0.0001 * LAMPORTS_PER_SOL; // 0.0001 SOL
export const CA = '6YGUi1TCwEMLqSmFfPjT9dVp7RWGVye17kqvaqhwpump';