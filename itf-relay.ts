import { parse } from "https://deno.land/x/xml@2.1.1/mod.ts";
import { debounce } from "https://deno.land/std@0.194.0/async/debounce.ts";
import * as archieml from "https://x.kite.run/lib/archieml.js";

const subscriptions = new Set<number>();
const map = new Map<number, Match>();

const VERSION = "1.9";

const DATA_ENDPOINT = "wss://livedata.betradar.com:2018/";

console.error(
	`Starting ITF Relay by Brandon Kalinowski v${VERSION}. Reads config.txt file from binary directory.`,
);

const configTemplate = `username: 
password: 
filename: itf-data.xml

[+courts]
CentreCourt: skip
Court8: skip
Court4: skip
Court1: skip
Court11: skip
Court7: skip
[]
`;

// If 50 make Ad
// If serve team home change serve marker

// courts: [{"court11"}]

// Initialize from config file

// Check if config file exists
try {
	const f = await Deno.open("config.txt");
} catch (e) {
	if (e instanceof Deno.errors.NotFound) {
		console.error("Config file does not exists. Writing template config.txt and exiting.");
		Deno.writeTextFileSync("config.txt", configTemplate);
		Deno.exit(1);
	}
}

let config: any = archieml.load(Deno.readTextFileSync("config.txt"));

function isConfigValid(config: any) {
	if (
		config &&
		config.username && config.password && config.filename &&
		config.filename.endsWith(".xml") &&
		config.courts && Array.isArray(config.courts)
	) {
		return true;
	}
	return false;
}

if (
	!isConfigValid(config)
) {
	console.error(
		"Invalid usage. Expected ArchieML config.txt file with username, password, XML filename, and court configs but got",
	);
	console.error(config);
	Deno.exit(1);
}

// Match ID examples
// "42324353"
// "42325417"

type Config = {
	username: string;
	password: string;
	filename: string;
	courts: {
		type: string,
		value: string,
	}[];
	cm: Map<string, string | number>
}

const ws = new WebSocket(DATA_ENDPOINT);

const parseConfigAndPrint = debounce(async () => {
	let configText = await Deno.readTextFile("config.txt");
	let newConfig: Config = archieml.load(configText) as Config;
	if (isConfigValid(newConfig)) {
		// Create config order map
		let cm = new Map<string, number>;
		newConfig.courts.forEach((ct, i) => {
			cm.set(ct.type, i)
		});
		newConfig.cm = cm;
		config = newConfig;
		console.error("[config] Change detected in config.txt. Updating subscriptions.")
		console.error(JSON.stringify(config));
	} else {
		console.error(`[error] Invalid config ${JSON.stringify(config)}`);
		return;
	}
	updateSubscriptions();
	printMatches();
}, 200);

async function watchConfigFile() {
	for await (const event of Deno.watchFs("config.txt")) {
		parseConfigAndPrint();
	}
}

function updateSubscriptions() {
	config.courts.forEach((ct: any) => {
		if (ct && ct.value && ct.type != "text") {
			if (ct.value == "skip") {
				return;
			}
			let v = ct.value;
			if (!subscriptions.has(v)) {
				subscribe(v);
				subscriptions.add(v);
			}
		} else {
			console.error(
				`[warning] invalid court value in config: "${JSON.stringify(ct)}"`,
			);
		}
	});
}

function formatName(input: string): string {
	let parts = input.split(", ")
	if (parts.length >= 2) {
		return `${parts[1][0]}. ${parts[0]}`
	}
	return input;
}

class Match {
	p1: string;
	p2: string;
	time: string;
	p1_score: number[];
	p2_score: number[];
	p1_serve: string;
	p2_serve: string;

	tournament: string;
	matchId: number;
	courtId: number;
	courtName: string;

	lastUpdated: Date;

	constructor() {
		this.p1 = "";
		this.p2 = "";
		this.time = "";
		this.p1_score = [0, 0, 0, 0];
		this.p2_score = [0, 0, 0, 0];
		this.p1_serve = "";
		this.p2_serve = "";

		this.tournament = "";
		this.courtId = 100;
		this.matchId = 0;
		this.courtName = "";
		this.lastUpdated = new Date();
	}

	toXML() {
		// 50 represents an advantage so handle its transform on printing here
		let p1g = this.p1_score[0];
		let p2g = this.p1_score[0];
		return `
<row>
	<CourtId>${this.courtId}</CourtId>
	<MatchTime>${this.time}</MatchTime>
	<CourtName>${this.courtName}</CourtName>
	<MatchId>${this.matchId}</MatchId>
	<LastUpdated>${this.lastUpdated.toISOString()}</LastUpdated>

	<Player_1_Name>${this.p1}</Player_1_Name>
	<Player_2_Name>${this.p2}</Player_2_Name>
	<Player_1_Points>${p1g == 50 ? "Ad" : p1g}</Player_1_Points>
	<Player_2_Points>${p2g == 50 ? "Ad" : p2g}</Player_2_Points>
	<Player_1_Serve>${this.p1_serve}</Player_1_Serve>
	<Player_2_Serve>${this.p2_serve}</Player_2_Serve>

	<Player_1_Set_1>${this.p1_score[1]}</Player_1_Set_1>
	<Player_1_Set_2>${this.p1_score[2]}</Player_1_Set_2>
	<Player_1_Set_3>${this.p1_score[3]}</Player_1_Set_3>
	<Player_2_Set_1>${this.p2_score[1]}</Player_2_Set_1>
	<Player_2_Set_2>${this.p2_score[2]}</Player_2_Set_2>
	<Player_2_Set_3>${this.p2_score[3]}</Player_2_Set_3>
</row>
`;
	}
	// { type: abc, value: id }

	updateCourt(match: any) {
		let court = "";
		let id = 6;
		if (match["court"]) {
			court = match["court"]?.["@name"];
			court = court.replaceAll(" ", "");
			id = config?.cm?.get(court);
			if (typeof id != 'undefined') {
				this.courtName = court;
				this.courtId = id;
			} else {
				console.error(`[config error] Court name "${court}" not found in config.txt`);
			}
		}
	}

	update(match: any) {
		this.updateCourt(match);
		this.lastUpdated = new Date();
		if (typeof match["@matchid"] != "undefined") {
			this.matchId = match["@matchid"];
		}

		let p1 = match?.["@t1name"];
		if (p1) {
			this.p1 = formatName(p1);
		}
		let p2 = match?.["@t2name"];
		if (p2) {
			this.p2 = formatName(p2);
		}
		let matchTime = match["@matchtime"];
		if (matchTime) {
			this.time = matchTime;
		}

		if (match.score) {
			let score: [] = match.score;
			let game = score.find((v) => {
				if (v["@type"] == "game") {
					return true;
				}
				return false;
			});
			if (typeof game !== "undefined") {
				this.p1_score[0] = game["@t1"];
				this.p2_score[0] = game["@t2"];
			}

			let set1 = score.find((v) => {
				if (v["@type"] == "set1") {
					return true;
				}
				return false;
			});
			if (typeof set1 !== "undefined") {
				this.p1_score[1] = set1["@t1"];
				this.p2_score[1] = set1["@t2"];
			}
			let set2 = score.find((v) => {
				if (v["@type"] == "set2") {
					return true;
				}
				return false;
			});
			if (typeof set2 !== "undefined") {
				this.p1_score[2] = set2["@t1"];
				this.p2_score[2] = set2["@t2"];
			}
			let set3 = score.find((v) => {
				if (v["@type"] == "set3") {
					return true;
				}
				return false;
			});
			if (typeof set3 !== "undefined") {
				this.p1_score[3] = set3["@t1"];
				this.p2_score[3] = set3["@t2"];
			}
		}
		if (match.serve) {
			let team = match.serve?.["@team"];
			if (team) {
				if (team == "home") {
					this.p1_serve = ".";
					this.p2_serve = "";
				} else if (team == "away") {
					this.p1_serve = "";
					this.p2_serve = ".";
				}
			}
		}
	}
}

function printMatches() {
	let str = "<data>";

	config.courts.forEach((ct: { type: string; value: number | string }) => {
		if (ct.value == "skip") {
			console.error(
				`[skip] Printing empty row for match ${ct.type}`,
			);
			str = str + "<row/>\n";
		} else {
			let n = Number(ct.value);
			if (!isNaN(n) && map.has(n)) {
				let match = map.get(n);
				if (!match) {
					console.error(
						"[edge case] Unexpected state. Match stopped existing in map",
					);
					str = str + "<row/>\n";
					return;
				}
				if (!match.matchId) {
					console.error(
						"[edge case] Invalid match is missing matchId stored in state",
					);
				}
				console.error(`Printing match ${match.matchId} on court "${match.courtName}"`);
				str = str + match.toXML();
			} else {
				console.error(`[edge case] Printing empty row for match ${ct.value} n="${n}"`);
				str = str + "<row/>\n";
			}
		}
	});
	str = str + "</data>";
	Deno.writeTextFile(config.filename, str);
}

function updateMatchWithData(matchData: any) {
	if (matchData && matchData["@matchid"]) {
		let id: number = matchData["@matchid"];
		let match = map.get(id);
		if (typeof match == "undefined") {
			match = new Match();
		}
		match.update(matchData);
		map.set(match.matchId, match);
	}
}

function subscribe(matchId: number | string) {
	ws.send(`<match matchid="${matchId}" feedtype="full"/>`); // The server appears to ignore my request for full
}

ws.onopen = function (e) {
	console.error("Connection Established");
	ws.send(
		`<login><credential><loginname value="${config.username}"/><password value="${config.password}"/></credential></login>`,
	);
	updateSubscriptions();
	watchConfigFile();
};

ws.onmessage = function (event) {
	let msg: string = event.data;
	if (msg.includes("<match")) {
		let parsed = parse(msg);

		if (parsed.match) {
			updateMatchWithData(parsed.match);
			console.error("Updated Match");
		} else {
			console.error("[edge case] No match defined in parsed data");
			console.error(msg);
			return;
		}
		printMatches();
	} else if (msg.includes("<ct/>")) {
		ws.send("<ct/>");
		console.error("CT");
	} else if (msg.includes("<login") && msg.includes(`result="valid`)) {
		console.error("Successful Login");
	} else {
		console.error(`[message] Data received from server`);
		console.error(event.data);
	}
};

ws.onclose = function (event) {
	if (event.wasClean) {
		alert(
			`[close] Connection closed cleanly, code=${event.code} reason=${event.reason}`,
		);
	} else {
		// e.g. server process killed or network down
		// event.code is usually 1006 in this case
		console.error("[close] Connection died");
	}
};

ws.onerror = function (error) {
	console.error(`[error] ${error}`);
};
