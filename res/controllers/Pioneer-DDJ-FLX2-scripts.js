// DDJ-FLX2 controller object.
//
// Primary hardware reference:
// https://assets.pioneerdjhub.com/DDJ-FLX2_MIDI_Message_List_E1.pdf
//
// The mapping follows the Pioneer DDJ-FLX2 MIDI message list for deck controls,
// mixer controls, performance pads, and documented illumination messages.
// Where the FLX2 exposes rekordbox-specific functions that Mixxx does not have
// as engine controls, the mapping either leaves the message unused or claims it
// without emulating rekordbox-only behavior.
//
// Important implementation notes:
// - The DDJ-FLX2 is physically a two-deck controller. fourDeckMode is a custom
//   Mixxx layer that reuses the left/right hardware sides for virtual decks
//   3 and 4. isVirtualDeckVisible() prevents hidden deck LED updates from
//   corrupting the currently visible physical deck.
// - Smart Fader (0x96/0x01) is claimed and echoed to its LED, but no Smart
//   Fader automation is implemented because Mixxx has no direct equivalent.
// - Smart CFX (0x96/0x09 in the Pioneer reference) is intentionally unmapped.
// - Vinyl mode is set ON at startup with MIDI OUT 9n 17 7F. The controller
//   cannot toggle Vinyl mode from the unit itself.
// - Fader-start messages (0x66, 0x5D, 0x52) are not implemented.
// - 0x60 is not bpm_tap; it is Pad 1 in pad mode 3.
var DDJFLX2 = {
  // Custom Mixxx layer mode:
  // false = physical decks control virtual decks 1 and 2
  // true  = physical decks control virtual decks 3 and 4
  fourDeckMode: false,

  // Maps physical decks to Mixxx virtual decks.
  // Index 0 is unused so deck numbers can be used directly.
  vDeckNo: [0, 1, 2],

  // Per-deck runtime storage.
  // Used for temporary values such as 14-bit MIDI reconstruction.
  vDeck: {},

  // Current shift button state.
  // Press/release logic is more reliable than toggle logic.
  shiftPressed: { left: false, right: false },

  loopPadSizes: [0.125, 0.25, 0.5, 1, 2, 4, 8, 16],
  padFxState: {},

  // Accumulates jog movement while browsing the library.
  jogCounter: 0,

  // Loop state: keeps track of currently active loop for each virtual deck.
  activeLoopSize: {},

  // Helper: check if shift is pressed for a specific deck group.
  isShiftPressed: function (group) {
    let deck = script.deckFromGroup(group);
    return deck === 1 ? this.shiftPressed.left : this.shiftPressed.right;
  },

  // Helper: resolve physical deck, virtual deck, and virtual deck group from a group.
  resolveDeck: function (group) {
    let physicalDeck = script.deckFromGroup(group);
    let virtualDeck = this.vDeckNo[physicalDeck];
    return {
      physicalDeck: physicalDeck,
      virtualDeck: virtualDeck,
      group: "[Channel" + virtualDeck + "]"
    };
  },

  // Helper: map a virtual deck number to its physical deck (1-based).
  // Virtual decks 1 and 3 map to physical deck 1 (left).
  // Virtual decks 2 and 4 map to physical deck 2 (right).
  virtualToPhysicalDeck: function (vDeckNo) {
    return (vDeckNo === 1 || vDeckNo === 3) ? 1 : 2;
  },

  // Helper: return the 0-based LED index for a virtual deck.
  // Physical deck 1 (left) → 0, physical deck 2 (right) → 1.
  // NOTE: use only for play/cue/sync LEDs, NOT for pad LEDs.
  virtualToLedIndex: function (vDeckNo) {
    return this.virtualToPhysicalDeck(vDeckNo) - 1;
  },

  // Helper: return the correct MIDI OUT status byte for pad LEDs.
  // Pioneer distinguishes MIDI-IN and MIDI-OUT channels for pads;
  // these are the correct MIDI-OUT / illumination channels per the spec.
  //   Left deck  normal : 0x97  shifted : 0x98
  //   Right deck normal : 0x99  shifted : 0x9A
  getPadLedStatus: function (physicalDeck, shifted) {
    if (physicalDeck === 1) {
      return shifted ? 0x98 : 0x97;
    }
    return shifted ? 0x9A : 0x99;
  },

  // Helper: return true only when vDeckNo is the virtual deck currently
  // assigned to its physical side.  Used to suppress LED writes for
  // background decks that are not visible on the controller.
  isVirtualDeckVisible: function (vDeckNo) {
    let physicalDeck = this.virtualToPhysicalDeck(vDeckNo);
    return this.vDeckNo[physicalDeck] === vDeckNo;
  },

  // Helper: extract hotcue pad number (1-8) from a hotcue mode control byte.
  hotcuePadFromControl: function (control) {
    return control + 1;
  },

  // Helper: extract loop pad number (1-8) from a loop mode control byte.
  loopPadFromControl: function (control) {
    return (control - 0x60) + 1;
  },

  // Helper: extract sampler pad number (1-8) from a sampler mode control byte.
  samplerPadFromControl: function (control) {
    return (control - 0x30) + 1;
  },

  // Helper: extract pad number from a pad FX mode control byte.
  padFxPadFromControl: function (control) {
    return (control & 0x07) + 1;
  },
};

DDJFLX2.init = function () {
  for (let i = 1; i <= 4; i++) {
    // Create runtime storage for each virtual deck.
    this.vDeck[i] = {
      volMSB: 0,
      rateMSB: 0,
    };

    // Initialize active loop size for each virtual deck.
    this.activeLoopSize[i] = null;

    let vgroup = "[Channel" + i + "]";

    // Keep LEDs synchronized with track loading state.
    engine.makeConnection(vgroup, "track_loaded", function (loaded, vgroup) {
      DDJFLX2.updateDeckLeds(vgroup, loaded);

      // Force cue LED off when a track is unloaded.
      if (!loaded) {
        let vDeckNo = script.deckFromGroup(vgroup);
        let physicalDeck = DDJFLX2.virtualToPhysicalDeck(vDeckNo);

        // Only update LEDs if the deck is currently visible
        // on the physical controller.
        if (vDeckNo === DDJFLX2.vDeckNo[physicalDeck]) {
          DDJFLX2.switchCueLED(DDJFLX2.virtualToLedIndex(vDeckNo), false);
        }
      }
    });

    // Keep play LED synchronized with Mixxx playback state.
    engine.makeConnection(vgroup, "play", function (ch, vgroup) {
      let vDeckNo = script.deckFromGroup(vgroup);
      if (!DDJFLX2.isVirtualDeckVisible(vDeckNo)) { return; }

      DDJFLX2.switchPlayLED(DDJFLX2.virtualToLedIndex(vDeckNo), ch);
    });

    // Keep sync LED synchronized with Mixxx sync state.
    engine.makeConnection(vgroup, "sync_enabled", function (ch, vgroup) {
      let vDeckNo = script.deckFromGroup(vgroup);
      if (!DDJFLX2.isVirtualDeckVisible(vDeckNo)) { return; }

      DDJFLX2.switchSyncLED(DDJFLX2.virtualToLedIndex(vDeckNo), ch);
    });

    // Keep pad LEDs synchronized with hotcue state.
    // This is the single source of truth for hotcue LED updates;
    // hotcueNActivate must NOT send its own LED echo.
    for (let j = 1; j <= 8; j++) {
      engine.makeConnection(
        vgroup,
        "hotcue_" + j + "_enabled",
        function (ch, vgroup, control) {
          let pad = Number(control.split("_")[1]);
          let vDeckNo = script.deckFromGroup(vgroup);
          if (!DDJFLX2.isVirtualDeckVisible(vDeckNo)) { return; }

          DDJFLX2.switchPadLED(
            DDJFLX2.virtualToPhysicalDeck(vDeckNo),
            pad,
            ch,
            false
          );
        }
      );
    }

    // Keep loop LEDs synchronized with actual loop state.
    engine.makeConnection(
      vgroup,
      "loop_enabled",
      function (enabled, vgroup) {
        let vDeckNo = script.deckFromGroup(vgroup);

        // Loop disabled externally
        if (!enabled) {
          DDJFLX2.activeLoopSize[vDeckNo] = null;
        }

        DDJFLX2.updateLoopPadLEDs(vDeckNo);
      }
    );

    // Enable Pioneer CDJ cue behavior.
    engine.setValue(vgroup, "cue_cdj", true);
  }

  DDJFLX2.LEDsOff();

  // Per the Pioneer MIDI reference, Vinyl mode cannot be changed from the
  // hardware. It is controlled by software with MIDI OUT 9n 17 hh.
  // Keep it enabled so platter rotation uses the scratch-capable 0x22 path.
  DDJFLX2.setVinylMode(true);

  // Focus the library after startup.
  // A short delay avoids initialization timing issues.
  engine.beginTimer(
    500,
    function () {
      engine.setValue("[Library]", "MoveFocus", 1);
    },
    true
  );

  // Request current hardware control positions from the controller.
  midi.sendSysexMsg(
    [0xf0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x02, 0x0a, 0x00, 0x03, 0x01, 0xf7],
    12
  );
};

DDJFLX2.shutdown = function () {
  DDJFLX2.LEDsOff();
};

DDJFLX2.LEDsOff = function () {
  // Smart Fader LED. Smart CFX (0x96/0x09) is intentionally not touched
  // because it is not mapped in Mixxx.
  midi.sendShortMsg(0x96, 0x01, 0x00);

  // Turn off all LEDs for both physical decks.
  for (let i = 0; i <= 1; i++) {
    midi.sendShortMsg(0x96 + i, 0x63, 0x00);
    midi.sendShortMsg(0x90 + i, 0x54, 0x00);
    midi.sendShortMsg(0x90 + i, 0x58, 0x00);
    midi.sendShortMsg(0x90 + i, 0x78, 0x00);
    midi.sendShortMsg(0x90 + i, 0x0b, 0x00);
    midi.sendShortMsg(0x90 + i, 0x0c, 0x00);

    // Use the correct MIDI-OUT pad channels (0x97/0x98 for left, 0x99/0x9A for right).
    let physicalDeck = i + 1;
    for (let j = 0; j <= 7; j++) {
      midi.sendShortMsg(DDJFLX2.getPadLedStatus(physicalDeck, false), j, 0x00);
    }
  }
};

DDJFLX2.updateDeckLeds = function (vgroup, value) {
  let vDeckNo = script.deckFromGroup(vgroup);
  let physicalDeck = DDJFLX2.virtualToPhysicalDeck(vDeckNo);

  // Clear LEDs when a track is unloaded.
  if (!value) {
    DDJFLX2.switchLEDs(vDeckNo);
    DDJFLX2.switchLoadedLED(vDeckNo, false);
    return;
  }

  // Refresh LEDs only if the virtual deck is currently mapped
  // to a visible physical deck.
  if (vDeckNo === DDJFLX2.vDeckNo[physicalDeck]) {
    DDJFLX2.switchLEDs(vDeckNo);
  }

  DDJFLX2.switchLoadedLED(vDeckNo, value);
};

DDJFLX2.switchLoadedLED = function (vDeckNo, loaded) {
  // Dedicated hardware LEDs for track loaded state.
  midi.sendShortMsg(0x9f, vDeckNo - 1, loaded ? 0x7f : 0x00);
};

DDJFLX2.setVinylMode = function (enabled) {
  // Pioneer setting message: deck 1/2 MIDI OUT 9n 17 hh.
  // enabled=true selects Vinyl mode ON; enabled=false selects Vinyl mode OFF.
  for (let deck = 0; deck <= 1; deck++) {
    midi.sendShortMsg(0x90 + deck, 0x17, enabled ? 0x7f : 0x00);
  }
};

DDJFLX2.LoadSelectedTrack = function (
  channel,
  control,
  value,
  status,
  group
) {
  // Ignore button release events.
  if (!value) {
    return;
  }

  let deck = DDJFLX2.resolveDeck(group);

  script.triggerControl(deck.group, "LoadSelectedTrack", true);
};

DDJFLX2.browseTracks = function (value) {
  // Convert relative MIDI encoder values into signed movement.
  let delta = value > 64 ? value - 128 : value;

  // Ignore micro-movements to filter out accidental touches
  // and mechanical noise from the jog wheel.
  // Threshold of 15 filters out all but deliberate movements.
  if (Math.abs(delta) < 15) {
    return;
  }

  // Accumulate intentional movements only.
  DDJFLX2.jogCounter += delta;

  // Threshold of 350 requires a firm, deliberate wheel turn
  // before triggering a single row move in the library.
  if (DDJFLX2.jogCounter > 350) {
    engine.setValue("[Library]", "MoveDown", true);
    DDJFLX2.jogCounter = 0;
  } else if (DDJFLX2.jogCounter < -350) {
    engine.setValue("[Library]", "MoveUp", true);
    DDJFLX2.jogCounter = 0;
  }
};

// Proper press/release handling avoids stuck shift state.
DDJFLX2.shiftLeft = function (
  channel,
  control,
  value
) {
  DDJFLX2.shiftPressed.left = value > 0;
};

DDJFLX2.shiftRight = function (
  channel,
  control,
  value
) {
  DDJFLX2.shiftPressed.right = value > 0;
};

// Outer jog ring used for temporary pitch bending.
DDJFLX2.jogWheel = function (
  channel,
  control,
  value,
  status,
  group
) {
  // Shift + jog browses the library.
  if (DDJFLX2.isShiftPressed(group)) {
    DDJFLX2.browseTracks(value);
    return;
  }

  let deck = DDJFLX2.resolveDeck(group);
  engine.setValue(deck.group, "jog", (value - 64) * 0.05);
};

// Shared helper for all scratch-related handlers.
DDJFLX2.doScratchTick = function (vDeckNo, value) {
  if (engine.isScratching(vDeckNo)) {
    engine.scratchTick(vDeckNo, value - 64);
  }
};

// Top platter surface used for scratching.
DDJFLX2.platterJog = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (DDJFLX2.isShiftPressed(group)) {
    DDJFLX2.browseTracks(value);
    return;
  }

  let deck = DDJFLX2.resolveDeck(group);
  DDJFLX2.doScratchTick(deck.virtualDeck, value);
};

DDJFLX2.platterJogShift = function (
  channel,
  control,
  value,
  status,
  group
) {
  DDJFLX2.platterJog(channel, control, value, status, group);
};

// Additional scratch input path exposed by the controller.
DDJFLX2.scratch = function (
  channel,
  control,
  value,
  status,
  group
) {
  let deck = DDJFLX2.resolveDeck(group);

  DDJFLX2.doScratchTick(deck.virtualDeck, value);
};

// Touch sensor enables or disables scratching mode.
DDJFLX2.touch = function (
  channel,
  control,
  value,
  status,
  group
) {
  let deck = DDJFLX2.resolveDeck(group);

  if (value) {
    engine.scratchEnable(
      deck.virtualDeck,
      1024,
      33 + 1 / 3,
      0.125,
      0.003
    );
  } else {
    engine.scratchDisable(deck.virtualDeck);
  }
};

DDJFLX2.touchShift = function (
  channel,
  control,
  value,
  status,
  group
) {
  DDJFLX2.touch(channel, control, value, status, group);
};

DDJFLX2.headmix = function (channel, control, value) {
  if (!value) {
    return;
  }

  // Toggle between cue and master monitoring extremes.
  let masterMixEnabled =
    engine.getValue("[Master]", "headMix") > 0.5;

  engine.setValue(
    "[Master]",
    "headMix",
    masterMixEnabled ? -1 : 1
  );

  midi.sendShortMsg(
    0x96,
    0x63,
    masterMixEnabled ? 0 : 0x7f
  );
};

DDJFLX2.toggleFourDeckMode = function (
  channel,
  control,
  value
) {
  if (!value) {
    return;
  }

  DDJFLX2.fourDeckMode = !DDJFLX2.fourDeckMode;

  // Reset all LEDs first to avoid stale states.
  DDJFLX2.LEDsOff();

  if (DDJFLX2.fourDeckMode) {
    // Reassign physical decks to virtual decks 3 and 4.
    DDJFLX2.vDeckNo[1] = 3;
    DDJFLX2.vDeckNo[2] = 4;

    DDJFLX2.switchLEDs(3);
    DDJFLX2.switchLEDs(4);

    DDJFLX2.switchLoadedLED(
      3,
      engine.getValue("[Channel3]", "track_loaded")
    );

    DDJFLX2.switchLoadedLED(
      4,
      engine.getValue("[Channel4]", "track_loaded")
    );

    midi.sendShortMsg(0x90, 0x54, 0x00);
    midi.sendShortMsg(0x91, 0x54, 0x00);
  } else {
    // Restore default mapping.
    DDJFLX2.vDeckNo[1] = 1;
    DDJFLX2.vDeckNo[2] = 2;

    DDJFLX2.switchLEDs(1);
    DDJFLX2.switchLEDs(2);

    DDJFLX2.switchLoadedLED(
      1,
      engine.getValue("[Channel1]", "track_loaded")
    );

    DDJFLX2.switchLoadedLED(
      2,
      engine.getValue("[Channel2]", "track_loaded")
    );
  }
};

DDJFLX2.play = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (value) {
    let deck = DDJFLX2.resolveDeck(group);

    let playing = engine.getValue(deck.group, "play");

    engine.setValue(deck.group, "play", !playing);
    // LED update is handled by the makeConnection callback in init().
  }
};

DDJFLX2.syncShort = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (DDJFLX2.isShiftPressed(group)) {
    return;
  }
  if (value) {
    let deck = DDJFLX2.resolveDeck(group);
    const enabled = engine.getValue(deck.group, "sync_enabled");
    engine.setValue(deck.group, "sync_enabled", enabled ? 0 : 1);
  }
};

DDJFLX2.smartFader = function (
  channel,
  control,
  value,
  status,
  group
) {
  // The FLX2 reports Smart Fader on 0x96/0x01, but Mixxx has no matching
  // engine control yet. Keep the MIDI message claimed so it does not trigger
  // unrelated behavior.
  midi.sendShortMsg(0x96, 0x01, value ? 0x7f : 0x00);
};

DDJFLX2.syncLong = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (DDJFLX2.isShiftPressed(group)) {
    return;
  }

  if (value) {
    let deck = DDJFLX2.resolveDeck(group);
    let enabled = engine.getValue(deck.group, "sync_enabled");
    engine.setValue(deck.group, "sync_enabled", enabled ? 0 : 1);
  }
};

DDJFLX2.padModeSelect = function (
  channel,
  control,
  value,
  status
) {
  midi.sendShortMsg(status, control, value ? 0x7f : 0x00);

  if (!value) {
    return;
  }

  // The controller enters its firmware pad-mode selector on Shift + Sync.
  // Actual pad presses are handled by the mode-specific MIDI note ranges.
};

// Store pitch fader MSB for 14-bit MIDI reconstruction.
DDJFLX2.rateMSB = function (
  channel,
  control,
  value,
  status,
  group
) {
  let deck = DDJFLX2.resolveDeck(group);
  DDJFLX2.vDeck[deck.virtualDeck]["rateMSB"] = value;
};

// Combine MSB and LSB to reconstruct full 14-bit pitch value.
DDJFLX2.rateLSB = function (
  channel,
  control,
  value,
  status,
  group
) {
  let deck = DDJFLX2.resolveDeck(group);

  let rateMSB = DDJFLX2.vDeck[deck.virtualDeck]["rateMSB"];
  let rate = 1 - ((rateMSB << 7) + value) / 0x1fff;

  engine.setValue(deck.group, "rate", rate);
};

// Store volume fader MSB for 14-bit MIDI reconstruction.
DDJFLX2.volumeMSB = function (
  channel,
  control,
  value,
  status,
  group
) {
  let deck = DDJFLX2.resolveDeck(group);
  DDJFLX2.vDeck[deck.virtualDeck]["volMSB"] = value;
};

// Combine MSB and LSB to reconstruct full 14-bit volume value.
DDJFLX2.volumeLSB = function (
  channel,
  control,
  value,
  status,
  group
) {
  let deck = DDJFLX2.resolveDeck(group);

  let volMSB = DDJFLX2.vDeck[deck.virtualDeck]["volMSB"];
  let vol = ((volMSB << 7) + value) / 0x3fff;

  engine.setValue(deck.group, "volume", vol);
};

// Store EQ MSB for 14-bit reconstruction.
// Deck is derived from the MIDI status byte (0xB0 = deck 1, 0xB1 = deck 2)
// because script.deckFromGroup() does not work with EQ rack group names.
DDJFLX2.eqMSB = function (channel, control, value, status, group) {
  let physicalDeck = (status & 0x0F) + 1;
  let virtualDeck = DDJFLX2.vDeckNo[physicalDeck];
  if (!DDJFLX2.vDeck[virtualDeck].eqMSB) {
    DDJFLX2.vDeck[virtualDeck].eqMSB = {};
  }
  DDJFLX2.vDeck[virtualDeck].eqMSB[control] = value;
};

// Combine MSB and LSB to reconstruct full 14-bit EQ value.
DDJFLX2.eqLSB = function (channel, control, value, status, group) {
  let physicalDeck = (status & 0x0F) + 1;
  let virtualDeck = DDJFLX2.vDeckNo[physicalDeck];
  let vgroup = "[Channel" + virtualDeck + "]";
  let eqGroup = "[EqualizerRack1_" + vgroup + "_Effect1]";

  let msb = (DDJFLX2.vDeck[virtualDeck].eqMSB || {})[control - 0x20] || 0;
  let combined = ((msb << 7) + value) / 0x3fff;
  let val = script.absoluteNonLin(combined * 127, 0, 1, 4);

  let eq;
  if (control === 0x27) { eq = 3; }      // high
  else if (control === 0x2B) { eq = 2; } // mid
  else { eq = 1; }                        // low

  engine.setValue(eqGroup, "parameter" + eq, val);
};

// Store CFX MSB for 14-bit reconstruction.
DDJFLX2.super1MSB = function (channel, control, value, status, group) {
  let physicalDeck = (control === 0x17 || control === 0x37) ? 1 : 2;
  let virtualDeck = DDJFLX2.vDeckNo[physicalDeck];
  if (!DDJFLX2.vDeck[virtualDeck].cfxMSB) {
    DDJFLX2.vDeck[virtualDeck].cfxMSB = 0;
  }
  DDJFLX2.vDeck[virtualDeck].cfxMSB = value;
};

// Combine MSB and LSB to reconstruct full 14-bit CFX value.
DDJFLX2.super1LSB = function (channel, control, value, status, group) {
  let physicalDeck = (control === 0x37 || control === 0x38) ?
    (control === 0x37 ? 1 : 2) :
    (control === 0x17 ? 1 : 2);
  let virtualDeck = DDJFLX2.vDeckNo[physicalDeck];
  let vgroup = "[Channel" + virtualDeck + "]";
  let qfxGroup = "[QuickEffectRack1_" + vgroup + "]";

  let msb = DDJFLX2.vDeck[virtualDeck].cfxMSB || 0;
  let combined = ((msb << 7) + value) / 0x3fff;
  let val = script.absoluteNonLin(combined * 127, 0, 0.5, 1);
  engine.setValue(qfxGroup, "super1", val);
};

DDJFLX2.cueDefault = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (value) {
    let deck = DDJFLX2.resolveDeck(group);

    // Match Pioneer CDJ cue behavior.
    if (engine.isScratching(deck.virtualDeck)) {
      engine.setValue(deck.group, "cue_set", true);
    } else {
      engine.setValue(deck.group, "cue_gotoandplay", true);
    }

    let cueSet = engine.getValue(deck.group, "cue_point") !== -1;

    midi.sendShortMsg(status, 0x0c, 0x7f * cueSet);

    midi.sendShortMsg(
      status,
      0x0b,
      0x7f * engine.getValue(deck.group, "play")
    );
  }
};

DDJFLX2.cueGotoandstop = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (value) {
    let deck = DDJFLX2.resolveDeck(group);

    engine.setValue(deck.group, "cue_gotoandstop", true);

    midi.sendShortMsg(
      status,
      0x0b,
      0x7f * engine.getValue(deck.group, "play")
    );
  }
};

// Trigger or create hotcues.
// LED updates are handled exclusively by the makeConnection callback in init()
// to avoid double-writes and race conditions.
DDJFLX2.hotcueNActivate = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (!value) {
    return;
  }

  let deck = DDJFLX2.resolveDeck(group);
  let hotcueNum = DDJFLX2.hotcuePadFromControl(control);
  let hotcue = "hotcue_" + hotcueNum;

  engine.setValue(deck.group, hotcue + "_activate", true);

  // Update play LED immediately for responsiveness.
  midi.sendShortMsg(
    0x90 + deck.physicalDeck - 1,
    0x0b,
    0x7f * engine.getValue(deck.group, "play")
  );
  // NOTE: hotcue pad LED is handled by the makeConnection on hotcue_X_enabled.
};

// Clear hotcues.
DDJFLX2.hotcueNClear = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (!value) {
    return;
  }

  let deck = DDJFLX2.resolveDeck(group);
  let hotcueNum = DDJFLX2.hotcuePadFromControl(control);

  engine.setValue(
    deck.group,
    "hotcue_" + hotcueNum + "_clear",
    true
  );

  // Turn off the pad LED using the correct MIDI-OUT channel.
  midi.sendShortMsg(
    DDJFLX2.getPadLedStatus(deck.physicalDeck, false),
    control,
    0x00
  );
};

DDJFLX2.applyPadFx = function (control, value, status, group, shifted) {
  let pad = DDJFLX2.padFxPadFromControl(control);
  let deck = DDJFLX2.resolveDeck(group);

  // Pads 4 and 8 are not handled in this mode.
  if (pad === 4 || pad === 8) {
    return;
  }

  // Map active pads to effect unit and slot:
  // Pad 1,2,3 → unit A, slot 1,2,3
  // Pad 5,6,7 → unit B, slot 1,2,3
  // Physical deck 1 (left):  unit A = 1, unit B = 3
  // Physical deck 2 (right): unit A = 2, unit B = 4
  const padToUnitSlot = {
    1: { unitOffset: 0, slot: 1 },
    2: { unitOffset: 0, slot: 2 },
    3: { unitOffset: 0, slot: 3 },
    5: { unitOffset: 1, slot: 1 },
    6: { unitOffset: 1, slot: 2 },
    7: { unitOffset: 1, slot: 3 },
  };
  let unitOffset = padToUnitSlot[pad].unitOffset;
  let slot = padToUnitSlot[pad].slot;

  let unit;
  if (deck.physicalDeck === 1) {
    unit = unitOffset === 0 ? 1 : 3;
  } else {
    unit = unitOffset === 0 ? 2 : 4;
  }

  let fxGroup = "[EffectRack1_EffectUnit" + unit + "]";
  let effectGroup = "[EffectRack1_EffectUnit" + unit + "_Effect" + slot + "]";
  let stateKey = deck.group + ":" + unit + ":" + slot;

  let ledStatus = DDJFLX2.getPadLedStatus(deck.physicalDeck, shifted);

  if (!value) {
    let saved = DDJFLX2.padFxState[stateKey];
    if (saved) {
      engine.setValue(fxGroup, "enabled", saved.enabled);
      engine.setValue(fxGroup, "mix", saved.mix);
      engine.setValue(effectGroup, "enabled", saved.effectEnabled);
      engine.setValue(effectGroup, "meta", saved.meta);
      for (let i = 1; i <= 4; i++) {
        engine.setValue(fxGroup, "group_[Channel" + i + "]_enable", saved.routing[i]);
      }
      delete DDJFLX2.padFxState[stateKey];
    }
    midi.sendShortMsg(ledStatus, control, 0x00);
    return;
  }

  if (!DDJFLX2.padFxState[stateKey]) {
    let routing = {};
    for (let i = 1; i <= 4; i++) {
      routing[i] = engine.getValue(fxGroup, "group_[Channel" + i + "]_enable");
    }
    DDJFLX2.padFxState[stateKey] = {
      enabled: engine.getValue(fxGroup, "enabled"),
      mix: engine.getValue(fxGroup, "mix"),
      effectEnabled: engine.getValue(effectGroup, "enabled"),
      meta: engine.getValue(effectGroup, "meta"),
      routing: routing,
    };
  }

  for (let i = 1; i <= 4; i++) {
    engine.setValue(fxGroup, "group_[Channel" + i + "]_enable", 0);
  }
  engine.setValue(fxGroup, "group_" + deck.group + "_enable", 1);
  engine.setValue(fxGroup, "enabled", 1);
  engine.setValue(fxGroup, "mix", 1);
  engine.setValue(effectGroup, "meta", 0.75);
  engine.setValue(effectGroup, "enabled", 1);

  midi.sendShortMsg(ledStatus, control, 0x7f);
};

DDJFLX2.padFx = function (
  channel,
  control,
  value,
  status,
  group
) {
  DDJFLX2.applyPadFx(control, value, status, group, false);
};

DDJFLX2.padFxShift = function (
  channel,
  control,
  value,
  status,
  group
) {
  DDJFLX2.applyPadFx(control, value, status, group, true);
};

DDJFLX2.loopRollPad = function (
  channel,
  control,
  value,
  status,
  group
) {
  let pad = DDJFLX2.loopPadFromControl(control);
  let size = DDJFLX2.loopPadSizes[pad - 1];
  let deck = DDJFLX2.resolveDeck(group);

  engine.setValue(
    deck.group,
    "beatlooproll_" + size + "_activate",
    value ? 1 : 0
  );

  // Use the correct MIDI-OUT channel for loop roll (shifted pad mode).
  midi.sendShortMsg(
    DDJFLX2.getPadLedStatus(deck.physicalDeck, true),
    control,
    value ? 0x7f : 0x00
  );
};

DDJFLX2.samplerPad = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (!value) {
    return;
  }

  let pad = DDJFLX2.samplerPadFromControl(control);
  let deck = DDJFLX2.resolveDeck(group);
  let samplerNo = pad + (deck.physicalDeck - 1) * 8;
  let samplerGroup = "[Sampler" + samplerNo + "]";

  script.triggerControl(samplerGroup, "cue_gotoandplay");

  // Use the correct MIDI-OUT channel for sampler pads (normal pad mode).
  midi.sendShortMsg(
    DDJFLX2.getPadLedStatus(deck.physicalDeck, false),
    control,
    engine.getValue(samplerGroup, "play") ? 0x7f : 0x00
  );
};

DDJFLX2.samplerStopPad = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (!value) {
    return;
  }

  let pad = DDJFLX2.samplerPadFromControl(control);
  let deck = DDJFLX2.resolveDeck(group);
  let samplerNo = pad + (deck.physicalDeck - 1) * 8;
  let samplerGroup = "[Sampler" + samplerNo + "]";

  script.triggerControl(samplerGroup, "stop");

  // Use the correct MIDI-OUT channel for sampler stop (shifted pad mode).
  midi.sendShortMsg(
    DDJFLX2.getPadLedStatus(deck.physicalDeck, true),
    control,
    0x00
  );
};

DDJFLX2.pfl = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (value) {
    let deck = DDJFLX2.resolveDeck(group);

    let pfl = !engine.getValue(deck.group, "pfl");

    engine.setValue(deck.group, "pfl", pfl);

    // In 4-deck mode the deck select LEDs are reused.
    if (!DDJFLX2.fourDeckMode) {
      midi.sendShortMsg(status, 0x54, 0x7f * pfl);
    }
  }
};

// Refresh all LEDs for a specific virtual deck.
// No-op when the virtual deck is not currently assigned to its physical
// side, preventing stale writes that would corrupt the visible deck's LEDs.
DDJFLX2.switchLEDs = function (vDeckNo) {
  if (!DDJFLX2.isVirtualDeckVisible(vDeckNo)) {
    return;
  }

  let d = DDJFLX2.virtualToLedIndex(vDeckNo);
  let physicalDeck = DDJFLX2.virtualToPhysicalDeck(vDeckNo);
  let vgroup = "[Channel" + vDeckNo + "]";

  DDJFLX2.switchPlayLED(
    d,
    engine.getValue(vgroup, "play")
  );

  midi.sendShortMsg(
    0x90 + d,
    0x0c,
    0x7f * (engine.getValue(vgroup, "cue_point") !== -1)
  );

  DDJFLX2.switchSyncLED(
    d,
    engine.getValue(vgroup, "sync_enabled")
  );

  if (!DDJFLX2.fourDeckMode) {
    midi.sendShortMsg(
      0x90 + d,
      0x54,
      0x7f * engine.getValue(vgroup, "pfl")
    );
  }

  for (let i = 1; i <= 8; i++) {
    let isButtonEnabled = engine.getValue(
      vgroup,
      "hotcue_" + i + "_enabled"
    );

    // Use physicalDeck (not ledIndex) and correct MIDI-OUT pad channel.
    DDJFLX2.switchPadLED(physicalDeck, i, isButtonEnabled, false);
  }

  // Update loop pad LEDs (single source of truth).
  DDJFLX2.updateLoopPadLEDs(vDeckNo);
};

DDJFLX2.switchPlayLED = function (deck, enabled) {
  midi.sendShortMsg(0x90 + deck, 0x0b, 0x7f * enabled);
};

DDJFLX2.switchSyncLED = function (deck, enabled) {
  midi.sendShortMsg(0x90 + deck, 0x58, 0x7f * enabled);
  midi.sendShortMsg(0x90 + deck, 0x78, 0x7f * enabled);
};

// Send a pad LED update using the correct MIDI-OUT illumination channel.
// physicalDeck: 1 (left) or 2 (right).
// pad: 1-based pad number.
// enabled: truthy = LED on, falsy = LED off.
// shifted: true = use shifted pad LED channel (0x98 / 0x9A).
DDJFLX2.switchPadLED = function (physicalDeck, pad, enabled, shifted) {
  let ledStatus = DDJFLX2.getPadLedStatus(physicalDeck, shifted || false);
  midi.sendShortMsg(ledStatus, pad - 1, enabled ? 0x7F : 0x00);
};

DDJFLX2.switchCueLED = function (deck, enabled) {
  midi.sendShortMsg(0x90 + deck, 0x0c, 0x7f * enabled);
};

// Helper: turn off all loop pad LEDs for a specific physical deck.
DDJFLX2.turnOffAllLoopPadLEDs = function (physicalDeck) {
  for (let pad = 1; pad <= 8; pad++) {
    DDJFLX2.switchPadLED(physicalDeck, pad, false, false);
  }
};

// Update all loop pad LEDs for a specific virtual deck (single source of truth).
// No-op when the virtual deck is not currently assigned to its physical side.
DDJFLX2.updateLoopPadLEDs = function (vDeckNo) {
  if (!DDJFLX2.isVirtualDeckVisible(vDeckNo)) {
    return;
  }

  let physicalDeck = DDJFLX2.virtualToPhysicalDeck(vDeckNo);

  DDJFLX2.turnOffAllLoopPadLEDs(physicalDeck);

  let activeSize = DDJFLX2.activeLoopSize[vDeckNo];

  if (activeSize === null) {
    return;
  }

  let padIndex = DDJFLX2.loopPadSizes.indexOf(activeSize);

  if (padIndex === -1) {
    return;
  }

  DDJFLX2.switchPadLED(physicalDeck, padIndex + 1, true, false);
};

DDJFLX2.loopPad = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (!value) {
    return;
  }

  let pad = DDJFLX2.loopPadFromControl(control);
  let size = DDJFLX2.loopPadSizes[pad - 1];
  let deck = DDJFLX2.resolveDeck(group);

  let loopEnabled = engine.getValue(
    deck.group,
    "loop_enabled"
  );

  let currentSize =
    DDJFLX2.activeLoopSize[deck.virtualDeck];

  // Pressing same active loop disables it.
  if (loopEnabled && currentSize === size) {

    engine.setValue(
      deck.group,
      "reloop_toggle",
      1
    );

    DDJFLX2.activeLoopSize[deck.virtualDeck] = null;

  } else {

    DDJFLX2.activeLoopSize[deck.virtualDeck] = size;

    script.triggerControl(
      deck.group,
      "beatloop_" + size + "_activate"
    );
  }

  DDJFLX2.updateLoopPadLEDs(
    deck.virtualDeck
  );
};

DDJFLX2.toggleDeck = function (
  channel,
  control,
  value,
  status,
  group
) {
  if (value) {
    // Shift + deck button loads the selected track.
    if (DDJFLX2.isShiftPressed(group)) {

      DDJFLX2.LoadSelectedTrack(
        channel,
        control,
        value,
        status,
        group
      );

    } else if (DDJFLX2.fourDeckMode) {

      let deck = DDJFLX2.resolveDeck(group);
      let vDeckNo;
      let led = 0x7f;

      if (deck.physicalDeck === 1) {

        // Toggle between virtual decks 1 and 3.
        DDJFLX2.vDeckNo[1] = DDJFLX2.vDeckNo[1] === 1 ? 3 : 1;

        if (DDJFLX2.vDeckNo[1] === 1) {
          led = 0;
        }

        vDeckNo = DDJFLX2.vDeckNo[1];

      } else {

        // Toggle between virtual decks 2 and 4.
        DDJFLX2.vDeckNo[2] = DDJFLX2.vDeckNo[2] === 2 ? 4 : 2;

        if (DDJFLX2.vDeckNo[2] === 2) {
          led = 0;
        }

        vDeckNo = DDJFLX2.vDeckNo[2];
      }

      midi.sendShortMsg(status, 0x54, led);

      // Refresh LEDs after remapping the physical deck.
      DDJFLX2.switchLEDs(vDeckNo);

      DDJFLX2.switchLoadedLED(
        vDeckNo,
        engine.getValue(
          "[Channel" + vDeckNo + "]",
          "track_loaded"
        )
      );
    }
  }
};
