import streamDeck, { Action, action, KeyAction, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { JsonValue } from "@elgato/utils";
import { ChildProcess, exec, ExecException, spawn } from 'child_process';
import { GlobalSettings, TestActionSettings } from "../settings";
import { Socket } from "net";
import path from "path";

/**
 * An example action class that displays a count that increments by one each time the button is pressed.
 */
@action({ UUID: "com.serafin-kaiser.appaudioswitcher.testaction" })
export class TestAction extends SingletonAction<TestActionSettings> {
	private utilsServerProcess: ChildProcess | null = null;
	private client: Socket | null = null;

	async tryLaunchUtilsServer(restart: boolean = false) {
		return new Promise<void>((resolve) => {
			if(this.utilsServerProcess !== null) {
				if(restart) {
					this.endUtilsServer();
				} else {
					resolve();
					return;
				}
			}
		
			this.utilsServerProcess = spawn(path.join(import.meta.dirname + "\\..\\audioSwitcherUtil\\AppAudioSwitcherUtility.exe"), ["--server"]);
			this.utilsServerProcess.stdout?.on("data", (data) => {
				const text = data.toString();
				if(text.includes("Listening on port")) {
					resolve();
				}
			})
		})
	}

	endUtilsServer() {
		this.client?.write("close");
		this.client?.end();
		this.client = null;

		if(this.utilsServerProcess !== null) {
			this.utilsServerProcess.kill();
		}
	}

	isConnected() {
		if(this.utilsServerProcess == null) {
			return false;
		}
		if(this.client == null) {
			return false;
		}
		return true;
	}

	async tryConnectToUtilsServer() {
		if(this.isConnected())
		{
			return;
		}

		await this.tryLaunchUtilsServer();

		if(this.client !== null) {
			this.client.end();
			this.client = null;
		}

		this.client = new Socket();

		this.client.on("data", (data) => {
			streamDeck.logger.info("Received: ", data.toString());
		})

		try {
			this.client.connect(32122, "127.0.0.1", () => {
				streamDeck.logger.info("Connected to Utils!");
			});
		} catch {
			streamDeck.logger.info("Connection error");
			this.endUtilsServer();
		}
	}

	/**
	 * The {@link SingletonAction.onWillAppear} event is useful for setting the visual representation of an action when it becomes visible. This could be due to the Stream Deck first
	 * starting up, or the user navigating between pages / folders etc.. There is also an inverse of this event in the form of {@link streamDeck.client.onWillDisappear}. In this example,
	 * we're setting the title to the "count" that is incremented in {@link SwitchAppAudioAction.onKeyDown}.
	 */
	override async onWillAppear(ev: WillAppearEvent<TestActionSettings>): Promise<void> {
		const settings = ev.payload.settings;
		ev.action.setTitle((settings.count ?? 0).toString());

		if(ev.action.isKey())
		{
			ev.action.showOk();
		}

		//await this.tryConnectToUtilsServer();
	}

	override onWillDisappear(ev: WillDisappearEvent<TestActionSettings>): Promise<void> | void {
		if(this.actions.next().done) {
			this.endUtilsServer();
		}
	}

	/**
	 * Listens for the {@link SingletonAction.onKeyDown} event which is emitted by Stream Deck when an action is pressed. Stream Deck provides various events for tracking interaction
	 * with devices including key down/up, dial rotations, and device connectivity, etc. When triggered, {@link ev} object contains information about the event including any payloads
	 * and action information where applicable. In this example, our action will display a counter that increments by one each press. We track the current count on the action's persisted
	 * settings using `setSettings` and `getSettings`.
	 */
	override async onKeyDown(ev: KeyDownEvent<TestActionSettings>): Promise<void> {
		// Update the count from the settings.
		const { settings } = ev.payload;
		settings.incrementBy ??= 1;
		settings.count = (settings.count ?? 0) + settings.incrementBy;

		// Update the current count in the action's settings, and change the title.
		await ev.action.setSettings(settings);
		await ev.action.setTitle(`${settings.count}`);

		streamDeck.logger.info(import.meta.dirname);

		await this.tryConnectToUtilsServer();
	}
}