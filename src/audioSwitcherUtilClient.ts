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

    connect(timeoutMs = 5000): Promise<NodeWebSocket> {
        return new Promise((resolve, reject) => {
            const socket = new NodeWebSocket(`ws://localhost:${this.port}/ws/`);
            streamDeck.logger.info(socket.url);
            
            let timeoutHandle = setTimeout(() => {
                streamDeck.logger.info("Timeout");
                this.socket?.close();
                reject(new Error("Connection to utils server timed out"));
            }, timeoutMs);

            socket.onopen = () => {
                clearTimeout(timeoutHandle);
                this.socket = socket;
                streamDeck.logger.info("Connected to utils server");
                resolve(socket);
            }

            socket.onerror = (err) => {
                clearTimeout(timeoutHandle);
                streamDeck.logger.error("Received error", err.error);
                reject(new Error("Websocket connection failed"));
            }
            
            socket.onmessage = (ev) => {
                const msg = JSON.parse(ev.data.toString()) as PluginMessage;
                streamDeck.logger.info("Received message: ", msg);
                this.dispatch(msg);
            }
            
            socket.onclose = (ev) => {
                streamDeck.logger.info("Closed connection with utils server", ev.code);
            }
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

        for (const { ctor, cb } of handlers) {
            cb(Object.assign(new ctor(), msg.Payload));
        }
    }
}