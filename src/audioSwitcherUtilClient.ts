import streamDeck from "@elgato/streamdeck";
import * as UtilTypes from "./audioSwitcherUtilTypes";
import NodeWebSocket from "ws";

export interface PluginMessage<TPayload = UtilTypes.IMessage> {
    Type: string
    Payload: TPayload
}

type MessageCallback<T extends UtilTypes.IMessage> = (msg: T) => void;

interface ListenerEntry<T extends UtilTypes.IMessage> {
    ctor: new (...args: UtilTypes.IMessage[]) => T;
    cb: MessageCallback<T>;
}

export class AudioSwitcherUtilClient {
    private socket: NodeWebSocket | null = null;
    private listeners = new Map<string, ListenerEntry<any>[]>();

    constructor(private port: number) {}

    private delay(ms: number) {
    	return new Promise(resolve => setTimeout(resolve, ms));
	}

    async connect(maxRetries = 5, retryTimeoutMs = 500): Promise<NodeWebSocket|null> {
         let lastError: any = null;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                streamDeck.logger.info(`Connecting (attempt ${attempt}/${maxRetries})`);
                await this.connectInternal(retryTimeoutMs);
                streamDeck.logger.info("Connected successfully");
                return this.socket;
            }
            catch (err) {
                lastError = err;
                if (attempt < maxRetries) {
                    await this.delay(500);
                }
            }
        }

        throw lastError ?? new Error("Failed to connect to utils server");
    }

    private async connectInternal(timeoutMs = 500): Promise<NodeWebSocket> {
        const socket = new NodeWebSocket(`ws://localhost:${this.port}/ws/`);

        const connectPromise = new Promise<NodeWebSocket>((resolve, reject) => {
            socket.onopen = () => resolve(socket);

            socket.onerror = (err) => {
                reject(new Error("WebSocket connection failed: " + err.message));
            };
        });

        let timeoutHandle: NodeJS.Timeout;
        const timeoutPromise = new Promise<NodeWebSocket>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                streamDeck.logger.error("Timeout event");
                socket.close();
                reject(new Error("Connection to utils server timed out"));
            }, timeoutMs);
        });

        return Promise.race([connectPromise, timeoutPromise]).then(ws => {
            clearTimeout(timeoutHandle);

            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data.toString());
                this.dispatch(msg);
            };

            ws.onclose = (ev) => {
                streamDeck.logger.info("Closed connection with utils server", ev.code);
            };

            this.socket = ws;
            streamDeck.logger.info("Connected to utils server");
            return ws;
        });
    }

    disconnect(code = 1000, reason = "Client disconnecting") {
        if(!this.socket || this.socket.readyState === NodeWebSocket.CLOSED) {
            return;
        }
        streamDeck.logger.info("Disconnect called");

        this.listeners.clear();
        this.socket.close(code, reason);
    }

    isConnected() : boolean {
        return this.socket !== null && this.socket.readyState === NodeWebSocket.OPEN;
    }

    send<TPayload extends UtilTypes.IMessage>(ctor: new (...args: any[]) => TPayload, message: TPayload) {
        if(!this.socket || this.socket.readyState !== NodeWebSocket.OPEN)
        {
            streamDeck.logger.warn("Trying to send message but no connection to utils server");
            return;
        }

        const msg: PluginMessage = { Type: ctor.name, Payload: message };
        streamDeck.logger.info("Sending message: ", msg);
        this.socket.send(JSON.stringify(msg));
    }

    on<TPayload extends UtilTypes.IMessage>(ctor: new (...args: any[]) => TPayload, cb: MessageCallback<TPayload>) {            
        const type = ctor.name;
        streamDeck.logger.info("Registering listener for events of type: ", type);
        if(!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        this.listeners.get(type)!.push({ ctor, cb });
    }

    private dispatch(msg: PluginMessage) {
        const handlers = this.listeners.get(msg.Type);
        if(!handlers) return;

        streamDeck.logger.info("Received message: ", msg);
        for (const { ctor, cb } of handlers) {
            cb(Object.assign(new ctor(), msg.Payload));
        }
    }
}