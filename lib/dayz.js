const Bzip2 = require('compressjs').Bzip2
const Core = require('../lib/core')
const Fallback = require('./Fallback')

const AppId = {
  DayZ: 221100
}

class Dayz extends Core {
  constructor() {
    super()

    // legacy goldsrc info response -- basically not used by ANYTHING now,
    // as most (all?) goldsrc servers respond with the source info reponse
    // delete in a few years if nothing ends up using it anymore
    this.goldsrcInfo = false;

    // unfortunately, the split format from goldsrc is still around, but we
    // can detect that during the query
    this.goldsrcSplits = false;

    // some mods require a challenge, but don't provide them in the new format
    // at all, use the old dedicated challenge query if needed
    this.legacyChallenge = false;

    // 2006 engines don't pass packet switching size in split packet header
    // while all others do, this need is detected automatically
    this._skipSizeInSplitHeader = false;

    this._challenge = '';
    
    this.fallback = new Fallback()
  }

  async run(state) {
    if (!this.options.port) this.options.port = 27015;
    await this.queryInfo(state);
    await this.queryChallenge();
    await this.queryPlayers(state);
    await this.queryRules(state);
    await this.cleanup(state);
  }

  async queryInfo(/** Results */ state) {
    this.debugLog("Requesting info ...");
    const b = await this.sendPacket(
      0x54,
      'Source Engine Query\0',
      this.goldsrcInfo ? 0x6D : 0x49,
      false
    );

    const reader = this.reader(b);

    if(this.goldsrcInfo) state.raw.address = reader.string();
    else state.raw.protocol = reader.uint(1);

    state.name = reader.string();
    state.map = reader.string();
    state.raw.folder = reader.string();
    state.raw.game = reader.string();
    state.raw.appId = reader.uint(2);
    state.raw.numplayers = reader.uint(1);
    state.maxplayers = reader.uint(1);

    if(this.goldsrcInfo) state.raw.protocol = reader.uint(1);
    else state.raw.numbots = reader.uint(1);

    state.raw.listentype = reader.uint(1);
    state.raw.environment = reader.uint(1);
    if(!this.goldsrcInfo) {
      state.raw.listentype = String.fromCharCode(state.raw.listentype);
      state.raw.environment = String.fromCharCode(state.raw.environment);
    }

    state.password = !!reader.uint(1);
    if(this.goldsrcInfo) {
      state.raw.ismod = reader.uint(1);
      if(state.raw.ismod) {
        state.raw.modlink = reader.string();
        state.raw.moddownload = reader.string();
        reader.skip(1);
        state.raw.modversion = reader.uint(4);
        state.raw.modsize = reader.uint(4);
        state.raw.modtype = reader.uint(1);
        state.raw.moddll = reader.uint(1);
      }
    }
    state.raw.secure = reader.uint(1);

    if(this.goldsrcInfo) {
      state.raw.numbots = reader.uint(1);
    } else {
      state.raw.version = reader.string();
      const extraFlag = reader.uint(1);
      if(extraFlag & 0x80) state.gamePort = reader.uint(2);
      if(extraFlag & 0x10) state.raw.steamid = reader.uint(8).toString();
      if(extraFlag & 0x40) {
        state.raw.sourcetvport = reader.uint(2);
        state.raw.sourcetvname = reader.string();
      }
      if(extraFlag & 0x20) state.raw.tags = reader.string().split(',');
      if(extraFlag & 0x01) {
        const gameId = reader.uint(8);
        const betterAppId = gameId.getLowBitsUnsigned() & 0xffffff;
        if (betterAppId) {
          state.raw.appId = betterAppId;
        }
      }
    }

    // from https://developer.valvesoftware.com/wiki/Server_queries
    if(
      state.raw.protocol === 7 && (
        state.raw.appId === 215
        || state.raw.appId === 17550
        || state.raw.appId === 17700
        || state.raw.appId === 240
      )
    ) {
      this._skipSizeInSplitHeader = true;
    }
    this.logger.debug("INFO: ", state.raw);
    if(state.raw.protocol === 48) {
      this.logger.debug("GOLDSRC DETECTED - USING MODIFIED SPLIT FORMAT");
      this.goldsrcSplits = true;
    }
  }

  async queryChallenge() {
    if(this.legacyChallenge) {
      // sendPacket will catch the response packet and
      // save the challenge for us
      this.debugLog("Requesting legacy challenge key ...");
      await this.sendPacket(
        0x57,
        null,
        0x41,
        false
      );
    }
  }

  async queryPlayers(/** Results */ state) {
    state.raw.players = [];

    this.debugLog("Requesting player list ...");
    const b = await this.sendPacket(
      0x55,
      null,
      0x44,
      true
    );

    if (b === null) {
      // Player query timed out
      // CSGO doesn't respond to player query if host_players_show is not 2
      // Conan Exiles never responds to player query
      // Just skip it, and we'll fill with dummy objects in cleanup()
      return;
    }

    const reader = this.reader(b);
    const num = reader.uint(1);
    for(let i = 0; i < num; i++) {
      reader.skip(1);
      const name = reader.string();
      const score = reader.int(4);
      const time = reader.float();

      this.debugLog("Found player: "+name+" "+score+" "+time);

      // connecting players don't count as players.
      if(!name) continue;

      state.raw.players.push({
        name:name, score:score, time:time
      });
    }
  }

  async queryRules(/** Results */ state) {
    const appId = state.raw.appId;

    // DayZ embeds some of the server information inside the tags attribute
    if (appId === AppId.DayZ) {

      if (state.raw.tags) {
        state.raw.dlcEnabled = false
        state.raw.firstPerson = false
        state.raw.privateHive = false
        state.raw.external = false

        for (const tag of state.raw.tags) {
          if (tag.startsWith('lqs')) {
            const value = parseInt(tag.replace('lqs', ''));
            if (!isNaN(value)) {
              state.raw.queue = value;
            }
          }
          if (tag.includes('no3rd')) {
            state.raw.firstPerson = true;
          }
          if (tag.includes('isDLC')) {
            state.raw.dlcEnabled = true;
          }
          if (tag.includes('privHive')) {
            state.raw.privateHive = true;
          }
          if (tag.includes('external')) {
            state.raw.external = true;
          }
          if (tag.includes(':')) {
            state.raw.time = tag;
          }
          if (tag.startsWith('etm')) {
            const value = parseInt(tag.replace('etm', ''));
            if (!isNaN(value)) {
              state.raw.dayAcceleration = value;
            }
          }
          if (tag.startsWith('entm')) {
            const value = parseInt(tag.replace('entm', ''));
            if (!isNaN(value)) {
              state.raw.nightAcceleration = value;
            }
          }
        }
      }
    }

    const rules = {}
    state.raw.rules = rules
    state.raw.dayzMods = []
    this.debugLog("Requesting rules ...");
    const b = await this.sendPacket(0x56,null,0x45,true);
    // if (b === null) return; // timed out - the server probably has rules disabled
    if (b === null) {
      // new Fallback // timed out - the server probably has rules disabled
      // const fallback = this.fallback.getMods(state.connect)
      // console.log(fallback);
      return
    }
    // probably theres an error here
    // ex: error for this server: 194.26.183.44:27016

    const dayZPayload = [];
    let dayZPayloadEnded = false;

    const reader = this.reader(b);
    const num = reader.uint(2);
    for(let i = 0; i < num; i++) {
      if (appId === AppId.DayZ && !dayZPayloadEnded) {
        const one = reader.uint(1);
        const two = reader.uint(1);
        const three = reader.uint(1);
        if (one !== 0 && two !== 0 && three === 0) {
          while (true) {
            const byte = reader.uint(1);
            if (byte === 0) break;
            dayZPayload.push(byte);
          }
          continue;
        } else {
          reader.skip(-3);
          dayZPayloadEnded = true;
        }
      }
      
      const key = reader.string();
      const value = reader.string();
      rules[key] = value;
    }

    state.raw.dayzMods = this.readDayzMods(Buffer.from(dayZPayload));
  }

  readDayzMods(/** Buffer */ buffer) {
    if (!buffer.length) {
    return {};
    }

    this.logger.debug("DAYZ BUFFER");
    this.logger.debug(buffer);

    const reader = this.reader(buffer);
    const version = this.readDayzByte(reader);
    const overflow = this.readDayzByte(reader);
    const dlc1 = this.readDayzByte(reader);
    const dlc2 = this.readDayzByte(reader);
    this.logger.debug("version " + version);
    this.logger.debug("overflow " + overflow);
    this.logger.debug("dlc1 " + dlc1);
    this.logger.debug("dlc2 " + dlc2);
    const mods = [];
    mods.push(...this.readDayzModsSection(reader, true));
    mods.push(...this.readDayzModsSection(reader, false));
    return mods;
  }
  readDayzModsSection(reader, withHeader) {
    const out = [];
    const count = this.readDayzByte(reader);
    for(let i = 0; i < count; i++) {
      const mod = {};
    if (withHeader) {
      const unknown = this.readDayzUint(reader, 4); // mod hash?
      if (i !== count - 1) {
      // For some reason this is 4 on all of them, but doesn't exist on the last one?
      const flag = this.readDayzByte(reader);
      //mod.flag = flag;
      }
      mod.id = this.readDayzUint(reader, 4);
    }
    mod.title = this.readDayzString(reader);
    out.push(mod);
    }
    return out;
  }
  readDayzUint(reader, bytes) {
    const out = [];
    for (let i = 0; i < bytes; i++) {
    out.push(this.readDayzByte(reader));
    }
    const buf = Buffer.from(out);
    const r2 = this.reader(buf);
    return r2.uint(bytes);
  }
  readDayzByte(reader) {
    const byte = reader.uint(1);
    if (byte === 1) {
    const byte2 = reader.uint(1);
    if (byte2 === 1) return 1;
    if (byte2 === 2) return 0;
    if (byte2 === 3) return 0xff;
    return 0; // ?
    }
    return byte;
  }
  readDayzString(reader) {
    const length = this.readDayzByte(reader);
    const out = [];
    for (let i = 0; i < length; i++) {
    out.push(this.readDayzByte(reader));
    }
    return Buffer.from(out).toString('utf8');
  }

  async cleanup(/** Results */ state) {

    // Reasign entries
    state.version = state.raw.version
    state.firstPerson = state.raw.firstPerson
    state.dlcEnabled = state.raw.dlcEnabled
    state.privateHive = state.raw.privateHive
    state.external = state.raw.external

    state.numplayers = state.raw.numplayers
    state.queue = state.raw.queue

    state.dayAcceleration = state.raw.dayAcceleration
    state.nightAcceleration = state.raw.nightAcceleration
    state.time = state.raw.time

    // Check if not a mod entry and delete
    if (state.raw.dayzMods > 0) {
      for (let i = 0; i <= state.raw.dayzMods.length - 1; i++) {
        if (state.raw.dayzMods[i].id === undefined || state.raw.dayzMods[i].title === 'Livonia DLC'){
          delete state.raw.dayzMods[i]
        }
      }
  
      const filteredMods = state.raw.dayzMods.filter((el) => {
        return el.constructor === Object && Object.keys(el).length > 0
      })
      state.mods = filteredMods
    }

    delete state.players
    delete state.bots
    delete state.raw
  }

  /**
   * Sends a request packet and returns only the response type expected
   * @param {number} type
   * @param {boolean} sendChallenge
   * @param {?string|Buffer} payload
   * @param {number} expect
   * @param {boolean=} allowTimeout
   * @returns Buffer|null
   **/
  async sendPacket(
    type,
    payload,
    expect,
    allowTimeout
  ) {
    for (let keyRetry = 0; keyRetry < 3; keyRetry++) {
      let receivedNewChallengeKey = false;
      const response = await this.sendPacketRaw(
        type, payload,
        (payload) => {
          const reader = this.reader(payload);
          const type = reader.uint(1);
          this.debugLog(() => "Received 0x" + type.toString(16) + " expected 0x" + expect.toString(16));
          if (type === 0x41) {
            const key = reader.uint(4);
            if (this._challenge !== key) {
              this.debugLog('Received new challenge key: 0x' + key.toString(16));
              this._challenge = key;
              receivedNewChallengeKey = true;
            }
          }
          if (type === expect) {
            return reader.rest();
          } else if (receivedNewChallengeKey) {
            return null;
          }
        },
        () => {
          if (allowTimeout) return null;
        }
      );
      if (!receivedNewChallengeKey) {
        return response;
      }
    }
    throw new Error('Received too many challenge key responses');
  }

  /**
   * Sends a request packet and assembles partial responses
   * @param {number} type
   * @param {boolean} sendChallenge
   * @param {?string|Buffer} payload
   * @param {function(Buffer)} onResponse
   * @param {function()} onTimeout
   **/
  async sendPacketRaw(
    type,
    payload,
    onResponse,
    onTimeout
  ) {
    const challengeAtBeginning = type === 0x55 || type === 0x56;
    const challengeAtEnd = type === 0x54 && !!this._challenge;

    if (typeof payload === 'string') payload = Buffer.from(payload, 'binary');

    const b = Buffer.alloc(5
      + (challengeAtBeginning ? 4 : 0)
      + (challengeAtEnd ? 4 : 0)
      + (payload ? payload.length : 0)
    );
    let offset = 0;

    let challenge = this._challenge;
    if (!challenge) challenge = 0xffffffff;

    b.writeInt32LE(-1, offset);
    offset += 4;

    b.writeUInt8(type, offset);
    offset += 1;

    if (challengeAtBeginning) {
      if (this.byteorder === 'le') b.writeUInt32LE(challenge, offset);
      else b.writeUInt32BE(challenge, offset);
      offset += 4;
    }

    if (payload) {
      payload.copy(b, offset);
      offset += payload.length;
    }

    if (challengeAtEnd) {
      if (this.byteorder === 'le') b.writeUInt32LE(challenge, offset);
      else b.writeUInt32BE(challenge, offset);
      offset += 4;
    }

    const packetStorage = {};
    return await this.udpSend(
      b,
      (buffer) => {
        const reader = this.reader(buffer);
        const header = reader.int(4);
        if(header === -1) {
          // full package
          this.debugLog("Received full packet");
          return onResponse(reader.rest());
        }
        if(header === -2) {
          // partial package
          const uid = reader.uint(4);
          if(!(uid in packetStorage)) packetStorage[uid] = {};
          const packets = packetStorage[uid];

          let bzip = false;
          if(!this.goldsrcSplits && uid & 0x80000000) bzip = true;

          let packetNum,payload,numPackets;
          if(this.goldsrcSplits) {
            packetNum = reader.uint(1);
            numPackets = packetNum & 0x0f;
            packetNum = (packetNum & 0xf0) >> 4;
            payload = reader.rest();
          } else {
            numPackets = reader.uint(1);
            packetNum = reader.uint(1);
            if(!this._skipSizeInSplitHeader) reader.skip(2);
            if(packetNum === 0 && bzip) reader.skip(8);
            payload = reader.rest();
          }

          packets[packetNum] = payload;

          this.debugLog(() => "Received partial packet uid: 0x"+uid.toString(16)+" num: "+packetNum);
          this.debugLog(() => "Received "+Object.keys(packets).length+'/'+numPackets+" packets for this UID");

          if(Object.keys(packets).length !== numPackets) return;

          // assemble the parts
          const list = [];
          for(let i = 0; i < numPackets; i++) {
            if(!(i in packets)) {
              throw new Error('Missing packet #'+i);
            }
            list.push(packets[i]);
          }

          let assembled = Buffer.concat(list);
          if(bzip) {
            this.debugLog("BZIP DETECTED - Extracing packet...");
            try {
              assembled = Buffer.from(Bzip2.decompressFile(assembled));
            } catch(e) {
              throw new Error('Invalid bzip packet');
            }
          }
          const assembledReader = this.reader(assembled);
          assembledReader.skip(4); // header
          return onResponse(assembledReader.rest());
        }
      },
      onTimeout
    );
  }
}

module.exports = Dayz;
