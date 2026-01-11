import streamDeck, { Action, action, DialRotateEvent, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, type SendToPluginEvent } from "@elgato/streamdeck";
import { JsonValue } from "@elgato/utils";
import type { DataSourcePayload, DataSourceResult } from "../sdpi";
import type { DialAction, DialDownEvent, KeyAction } from "@elgato/streamdeck";
import { ChildProcess, exec, ExecException, spawn } from 'child_process';
import { GlobalSettings, SoundSwitchSettings } from "../settings";
import { Socket } from "net";
import path from "path";

type Device = {
	Id: string,
	Name: string
}

type ActionDeviceInfo = {
	settings: SoundSwitchSettings,
	devices: Device[],
	curDeviceIdx: number
}

type Response = {
	id: string,
	payload: Object
}

type DevicesPayload = {
	devices: Device[]
}

type FocusedPayload = {
	processId: string,
	processName: string,
	deviceId: string,
	processIconBase64?: string
}

/**
 * An example action class that displays a count that increments by one each time the button is pressed.
 */
@action({ UUID: "com.serafin-kaiser.appaudioswitcher.switchappaudio" })
export class SwitchAppAudioAction extends SingletonAction<SoundSwitchSettings> {
	private curDevices: Array<{ Id: string, Name: string }> = new Array();
	private timer: NodeJS.Timeout | undefined;
	private curProcessId: number = 0;
	private forceProcessUpdate: boolean = false;

	// --- Utils Server ---

	private utilsServerProcess: ChildProcess | null = null;
	private client: Socket | null = null;

	async tryLaunchUtilsServer(restart: boolean = false): Promise<void> {
		if(restart) {
			this.endUtilsServer();
		}

		if(this.utilsServerProcess !== null) {
			return;
		}

		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.utilsServerProcess?.kill();
				this.utilsServerProcess = null;
				reject(new Error("Server startup timed out")) 
			}, 5000);

			try {
				this.utilsServerProcess = spawn(path.join(import.meta.dirname + "\\..\\audioSwitcherUtil\\AppAudioSwitcherUtility.exe"), ["--server"]);
				this.utilsServerProcess.stdout?.on("data", (data) => {
					const text = data.toString();
					if(text.includes("Listening on port")) {
						clearTimeout(timeout)
						resolve();
					}
				});
			}
			catch (e) {
				clearTimeout(timeout);
				reject(e);
			}
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

	async tryConnectToUtilsServer(): Promise<void> {
		return new Promise<void>(async (resolve, reject) => {
			if(this.isConnected())
			{
				resolve();
				return;
			}

			this.tryLaunchUtilsServer().then(() => {
				if(this.client !== null) {
					this.client.end();
					this.client = null;
				}

				this.client = new Socket();

				this.client.on("data", (data) => {
					this.messageReceived(data.toString());
				})
 
				try {
					this.client.connect(32122, "127.0.0.1", () => {
						streamDeck.logger.info("Connected to Utils!");
						resolve();
					});
				} catch (e) {
					this.endUtilsServer();
					reject(e);
				}
			}, (e) => {
				reject(e);
			});
		});
	}

	async sendMessage(message: string) {
		await this.tryConnectToUtilsServer();
		streamDeck.logger.debug(`Sending Message: ${message}`);
		this.client?.write(message);
	}

	async messageReceived(message: string) {
		streamDeck.logger.info(`Received message: ${message}`);

		let response: Response;

		try {
			response = JSON.parse(message);
		}
		catch {
			return;
		}

		switch (response.id) {
			case "devices": {
				this.handleDevicesMessageReceived(response.payload as DevicesPayload);
			}
			case "focused": {
				await this.handleFocusedMessageReceived(response.payload as FocusedPayload);
			}
			case "icon": {
				await this.handleFocusedIconMessageReceived(response.payload as FocusedPayload);
			}
		}
	}

	async handleDevicesMessageReceived(devicesPayload: DevicesPayload) {
		this.curDevices = devicesPayload.devices ?? [];
		streamDeck.logger.info(devicesPayload);
	}

	async handleFocusedMessageReceived(focusedPayload: FocusedPayload) {
		if(focusedPayload === undefined) return;

		let newProcessId = 0;
		try {
			newProcessId = Number.parseInt(focusedPayload.processId);
		}
		catch {
			return;
		}

		if((newProcessId !== this.curProcessId && newProcessId !== 0) || this.forceProcessUpdate)
		{
			this.forceProcessUpdate = false;
			this.curProcessId = newProcessId;
			for (const action of this.actions) {
				action.setTitle(focusedPayload.processName);
				if(action.isDial())
				{
					if(focusedPayload.deviceId !== '') {
						await this.trySetCurSelectedDeviceId(action, focusedPayload.deviceId);
						this.updateDialLayout(action);
					}
				}
			}
			this.sendMessage("--get focused --icon");
		}
	}

	async handleFocusedIconMessageReceived(focusedPayload: FocusedPayload) {
		for (const action of this.actions) {
			if(action.isDial())
			{
				action.setFeedback({
					icon: `data:image/png;base64,${focusedPayload.processIconBase64}`
				})
			}
		} 
	}

	async execAwait(cmd: string): Promise<{ error: ExecException|null; stdout: string; stderr: string }> 
	{ 
		return new Promise((resolve) => { 
			exec(cmd, (error, stdout, stderr) => { 
				resolve({ error, stdout, stderr }); 
			}); 
		}); 
	}

	private async updateProcessIds(force: boolean = false) {
		if(force) {
			this.forceProcessUpdate = true;
		}
		this.sendMessage("--get focused");
	}

	private async tryStartProcessUpdateTimer() {
		if(this.timer)
		{
			return;
		}

		this.timer = setInterval(() => {
			this.updateProcessIds();
		}, 1000);
	}

	private async updateDialLayout(action: DialAction<SoundSwitchSettings>) {
		// Update 
		const deviceInfo = await this.getCurDeviceForAction(action);

		action.setFeedback({
			value: deviceInfo?.Name.toString() ?? "None",
		});
	}

	private async getActionDeviceData(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>): Promise<ActionDeviceInfo|null>
	{
		if(action === undefined) return null;
		const settings = await action?.getSettings();
		if(settings === undefined) return null;
		const devicesForAction = this.curDevices.filter((d) => settings.activeDevices?.includes(d.Id));
		let deviceIndex = devicesForAction.findIndex((d) => (d.Id === settings.curSelectedDeviceId));
		return { settings: settings, devices: devicesForAction, curDeviceIdx: deviceIndex };
	}

	private async getCurDeviceForAction(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>): Promise<Device|undefined> {
		const actionDeviceInfo = await this.getActionDeviceData(action);
		if(actionDeviceInfo === null) return undefined;

		let idx = actionDeviceInfo?.curDeviceIdx ?? 0;
		if(actionDeviceInfo.devices.length == 0) return undefined;
		if(idx < 0 || idx >= actionDeviceInfo.devices.length) {
			idx = 0;
		}
	
		const deviceInfo = this.curDevices.find((d) => d.Id === actionDeviceInfo.devices[idx]?.Id);
		return deviceInfo;
	}

	private async trySetCurSelectedDeviceId(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>, deviceId: string) {
		let activationDeviceInfo = await this.getActionDeviceData(action);
		if(activationDeviceInfo === null) return;

		const device = activationDeviceInfo.devices.find((d) => d.Id === deviceId);
		if(device !== undefined) {
			activationDeviceInfo.settings.curSelectedDeviceId = deviceId;
			await action.setSettings(activationDeviceInfo.settings);
		}
	}

	private async cycleDeviceIndexForAction(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>, incr: boolean) {
		let actionDeviceInfo = await this.getActionDeviceData(action);
		if(actionDeviceInfo === null) return;

		let idx = actionDeviceInfo.curDeviceIdx;
		idx = idx + (incr ? 1 : -1);
		if(idx < 0) {
			idx = actionDeviceInfo.devices.length - 1;
		}
		else if(idx >= actionDeviceInfo.devices.length) {
			idx = 0;
		}

		actionDeviceInfo.settings.curSelectedDeviceId = actionDeviceInfo.devices[idx].Id;
		await action.setSettings(actionDeviceInfo.settings);
	}

	/**
	 * The {@link SingletonAction.onWillAppear} event is useful for setting the visual representation of an action when it becomes visible. This could be due to the Stream Deck first
	 * starting up, or the user navigating between pages / folders etc.. There is also an inverse of this event in the form of {@link streamDeck.client.onWillDisappear}. In this example,
	 * we're setting the title to the "count" that is incremented in {@link SwitchAppAudioAction.onKeyDown}.
	 */
	override async onWillAppear(ev: WillAppearEvent<SoundSwitchSettings>): Promise<void> {
		try {
			this.sendMessage("--get devices");
		}
		catch (e) {
			streamDeck.logger.error(e);
			return;
		}

		if(ev.action.isDial()) {
			this.updateDialLayout(ev.action);
		}

		// Update once immediately
		this.updateProcessIds(true);
		// Set a timer for this action if it doesn't have one yet
		this.tryStartProcessUpdateTimer(); 
	}

	override onWillDisappear(ev: WillDisappearEvent<SoundSwitchSettings>): Promise<void> | void {
		if(this.actions.next().done) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * Listens for the {@link SingletonAction.onKeyDown} event which is emitted by Stream Deck when an action is pressed. Stream Deck provides various events for tracking interaction
	 * with devices including key down/up, dial rotations, and device connectivity, etc. When triggered, {@link ev} object contains information about the event including any payloads
	 * and action information where applicable. In this example, our action will display a counter that increments by one each press. We track the current count on the action's persisted
	 * settings using `setSettings` and `getSettings`.
	 */
	override async onKeyDown(ev: KeyDownEvent<SoundSwitchSettings>): Promise<void> {
		// Update the count from the settings.
		const { settings } = ev.payload;
		settings.incrementBy ??= 1;
		settings.count = (settings.count ?? 0) + settings.incrementBy;

		// Update the current count in the action's settings, and change the title.
		await ev.action.setSettings(settings);
		await ev.action.setTitle(`${settings.count}`);
	}

	override async onDialRotate(ev: DialRotateEvent<SoundSwitchSettings>): Promise<void> {
		const ticks = ev.payload.ticks;
		await this.cycleDeviceIndexForAction(ev.action, ticks > 0);
		this.updateDialLayout(ev.action);
	}

	override async onDialDown(ev: DialDownEvent<SoundSwitchSettings>): Promise<void> {
		const device = await this.getCurDeviceForAction(ev.action);
		if(device) {
			const res = await this.execAwait(`audioSwitcherUtil\\AppAudioSwitcherUtility.exe --set appDevice --process ${this.curProcessId.toString()} --device ${device.Id}`);
			if(res.error) {
				streamDeck.logger.error(res.error);
			}
		}
	}

	/**
	 * Listen for messages from the property inspector.
	 * @param ev Event information.
	 */
	override onSendToPlugin(ev: SendToPluginEvent<JsonValue, SoundSwitchSettings>): Promise<void> | void {
		// Check if the payload is requesting a data source, i.e. the structure is { event: string }
		if (ev.payload instanceof Object && "event" in ev.payload && ev.payload.event === "getProducts") {
			// Send the product ranges to the property inspector.
			streamDeck.ui.sendToPropertyInspector({
				event: "getProducts",
				items: this.#getAvailableDevices(),
			} satisfies DataSourcePayload);
		}
	}

	#getAvailableDevices(): DataSourceResult {
		let array = this.curDevices.map((device) => 
			({ 
				value: device.Id,
			 	label: device.Name
			}))
		return array;
	}
}