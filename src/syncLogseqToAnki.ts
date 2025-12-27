import "@logseq/libs";
import * as AnkiConnect from "./anki-connect/AnkiConnect";
import {LazyAnkiNoteManager} from "./anki-connect/LazyAnkiNoteManager";
import {
    getTemplateFront,
    getTemplateBack, getTemplateMediaFiles
} from "./templates/AnkiCardTemplates";
import {Note} from "./notes/Note";
import {ClozeNote} from "./notes/ClozeNote";
import {MultilineCardNote} from "./notes/MultilineCardNote";
import _ from "lodash";
import {
    escapeClozesAndMacroDelimiters,
    handleAnkiError,
    getCaseInsensitive,
    sortAsync,
    splitNamespace, getLogseqBlockPropSafe
} from "./utils/utils";
import path from "path-browserify";
import {ANKI_CLOZE_REGEXP, MD_PROPERTIES_REGEXP, SUCCESS_ICON, WARNING_ICON} from "./constants";
import {convertToHTMLFile} from "./logseq/LogseqToHtmlConverter";
import {LogseqProxy} from "./logseq/LogseqProxy";
import pkg from "../package.json";
import {SwiftArrowNote} from "./notes/SwiftArrowNote";
import {ProgressNotification} from "./ui/customized/ProgressNotification";
import {Confirm} from "./ui/general/Confirm";
import {ImageOcclusionNote} from "./notes/ImageOcclusionNote";
import NoteHashCalculator from "./notes/NoteHashCalculator";
import {cancelable, CancelablePromise} from "cancelable-promise";
import {DepGraph} from "dependency-graph";
import {NoteUtils} from "./notes/NoteUtils";
import {ActionNotification} from "./ui/general/ActionNotification";
import {showModelWithButtons} from "./ui/general/ModelWithBtns";
import {SyncSelectionDialog} from "./ui/customized/SyncSelectionDialog";
import {SyncResultDialog} from "./ui/customized/SyncResultDialog";
import {BlockEntity, PageEntity, PageIdentity} from "@logseq/libs/dist/LSPlugin";
export class LogseqToAnkiSync {
    static isSyncing: boolean;
    graphName: string;
    modelName: string;

    public async sync(): Promise<void> {
        if (await LogseqProxy.App.checkCurrentIsDbGraph()  === true) {
            await logseq.UI.showMsg("Anki sync not supported in DB Graphs yet.\nDevelopment to support it is going on in db branch.", "error");
            return;
        }
        if (LogseqToAnkiSync.isSyncing) {
            console.log(`Syncing already in process...`);
            return;
        }
        LogseqToAnkiSync.isSyncing = true;
        try {
            await this.performSync();
        } catch (e) {
            handleAnkiError(e.toString());
            logseq.provideUI({
                key: `logseq-anki-sync-progress-notification-${logseq.baseInfo.id}`,
                template: ``,
            });
            console.error(e);
        }
        LogseqToAnkiSync.isSyncing = false;
    }

    private async performSync(): Promise<void> {
        this.graphName = _.get(await logseq.App.getCurrentGraph(), "name") || "Default";
        this.modelName = `${this.graphName}Model`.replace(/\s/g, "_");
        console.log(
            `%cStarting Logseq to Anki Sync V${pkg.version} for graph ${this.graphName}`,
            "color: green; font-size: 1.5em;",
        );

        // -- Request Access --
        await AnkiConnect.requestPermission();

        // -- Create models if it doesn't exists --
        await AnkiConnect.createModel(
            this.modelName,
            ["uuid-type", "uuid", "Text", "Extra", "Breadcrumb", "Config"],
            getTemplateFront(),
            getTemplateBack(),
            getTemplateMediaFiles()
        );

        // -- Get the notes that are to be synced from logseq --
        const scanNotification = new ProgressNotification(
            `Scanning Logseq Graph <span style="opacity: 0.8">[${this.graphName}]</span>:`,
            5,
            "graph",
        );
        let notes: Array<Note> = [];
        notes = [...notes, ...(await ClozeNote.getNotesFromLogseqBlocks())];
        scanNotification.increment();
        notes = [...notes, ...(await SwiftArrowNote.getNotesFromLogseqBlocks())];
        scanNotification.increment();
        notes = [...notes, ...(await ImageOcclusionNote.getNotesFromLogseqBlocks())];
        scanNotification.increment();
        notes = [...notes, ...(await MultilineCardNote.getNotesFromLogseqBlocks(notes))];
        scanNotification.increment();
        await new Promise((resolve) => setTimeout(resolve, 1000)); // wait 1 sec
        scanNotification.increment();

        // -- Collect all unique model names --
        const allModelNames = new Set([this.modelName]);
        for (const note of notes) {
            const customModelName = note.properties['ankiNoteType'] || note.properties['anki-note-type'];
            if (customModelName) {
                allModelNames.add(customModelName);
            }
        }

        // -- Prepare Anki Note Managers for all models --
        const ankiNoteManagers = new Map<string, LazyAnkiNoteManager>();
        for (const modelName of allModelNames) {
            const manager = new LazyAnkiNoteManager(modelName);
            try {
                await manager.init();
                ankiNoteManagers.set(modelName, manager);
            } catch (e) {
                console.warn(`Failed to initialize manager for model: ${modelName}`, e);
            }
        }

        // Set the default manager for backward compatibility
        const ankiNoteManager = ankiNoteManagers.get(this.modelName);
        Note.setAnkiNoteManager(ankiNoteManager);

        for (const note of notes) {
            // Force persistance of note's logseq block uuid across re-index by adding id property to block in logseq
            if (!note.properties["id"]) {
                try {
                    await LogseqProxy.Editor.upsertBlockProperty(note.uuid, "id", note.uuid);
                } catch (e) {
                    console.error(e);
                }
            }
        }

        notes = await sortAsync(notes, async (a) => {
            return _.get(await LogseqProxy.Editor.getBlock(a.uuid), "id", 0); // Sort by db/id
        });
        //scanNotification.increment();

        // -- Declare some variables to keep track of different operations performed --
        const failedCreated: { [key: string]: any } = {};
        const failedUpdated: { [key: string]: any } = {};
        const failedDeleted: { [key: string]: any } = {};
        const toCreateNotesOriginal = new Array<Note>(),
            toUpdateNotesOriginal = new Array<Note>(),
            toDeleteNotesOriginal = new Array<number>();
        // Helper function to get AnkiId from appropriate manager
        const getAnkiIdFromManagers = (note: Note): number => {
            const customModelName = note.properties['ankiNoteType'] || note.properties['anki-note-type'];
            const targetModelName = customModelName || this.modelName;
            const targetManager = ankiNoteManagers.get(targetModelName);

            if (!targetManager) {
                console.warn(`No manager found for model: ${targetModelName}`);
                return null;
            }

            // Search in target manager's note map
            const ankiNotesArr = Array.from(targetManager.noteInfoMap.values());
            const filteredankiNotesArr = ankiNotesArr.filter(
                (ankiNote) => ankiNote.fields["uuid"]?.value == note.uuid,
            );

            if (filteredankiNotesArr.length == 0) return null;
            else return parseInt(filteredankiNotesArr[0].noteId);
        };

        for (const note of notes) {
            const ankiId = getAnkiIdFromManagers(note);
            if (ankiId == null || isNaN(ankiId)) toCreateNotesOriginal.push(note);
            else {
                note["ankiId"] = ankiId; // Cache the result
                toUpdateNotesOriginal.push(note);
            }
        }
        const noteAnkiIds: Array<number> = notes.map((note) => {
            const ankiId = getAnkiIdFromManagers(note);
            return ankiId;
        }).filter(id => id != null); // Flatten current logseq block's anki ids

        // Collect all AnkiIds from all managers
        const allAnkiIds: Array<number> = [];
        for (const manager of ankiNoteManagers.values()) {
            allAnkiIds.push(...manager.noteInfoMap.keys());
        }

        for (const ankiId of allAnkiIds) {
            if (!noteAnkiIds.includes(ankiId)) {
                toDeleteNotesOriginal.push(ankiId);
            }
        }

        // -- Prompt the user what actions are going to be performed --
        // Perform caching while user is reading the prompt
        let buildNoteHashes: any = {
            dontCreateCancelable: false,
            cancel: () => {
                buildNoteHashes.dontCreateCancelable = true;
            },
        };
        setTimeout(() => {
            if (buildNoteHashes.dontCreateCancelable == false) {
                buildNoteHashes = new CancelablePromise(async (resolve, reject, onCancel) => {
                    await new Promise((resolve) => setTimeout(resolve, 10000));
                    for (const note of notes) {
                        await NoteHashCalculator.getHash(note, ["", [], "", "", [], ""]);
                        if (buildNoteHashes.isCanceled()) break;
                    }
                });
            }
        }, 4000);

        const noteSelection = await SyncSelectionDialog(
            toCreateNotesOriginal,
            toUpdateNotesOriginal,
            toDeleteNotesOriginal,
        );
        if (!noteSelection) {
            buildNoteHashes.cancel();
            window.parent.LogseqAnkiSync.dispatchEvent("syncLogseqToAnkiComplete");
            console.log("Sync Aborted by user!");
            return;
        }
        const {toCreateNotes, toUpdateNotes, toDeleteNotes} = noteSelection;
        console.log(
            "toCreateNotes",
            toCreateNotes,
            "toUpdateNotes",
            toUpdateNotes,
            "toDeleteNotes",
            toDeleteNotes,
        );

        if (
            toCreateNotes.length == 0 &&
            toUpdateNotes.length == 0 &&
            toDeleteNotes.length >= 10
        ) {
            // Prompt the user again if they are about to delete a lot of notes
            const confirm_msg = `<b class="text-red-600">This will delete all your notes in anki that are generated from this graph.</b><br/>Are you sure you want to continue?`;
            if (!(await Confirm(confirm_msg))) {
                buildNoteHashes.cancel();
                window.parent.LogseqAnkiSync.dispatchEvent("syncLogseqToAnkiComplete");
                console.log("Sync Aborted by user!");
                return;
            }
        }
        buildNoteHashes.cancel();

        // -- Sync --
        const start_time = performance.now();
        const twentyPercent = Math.ceil(
            (toCreateNotes.length + toUpdateNotes.length + toDeleteNotes.length) / 20,
        );
        const syncNotificationMsg = "Syncing logseq notes to anki...";
        const syncNotificationObj = new ProgressNotification(
            syncNotificationMsg,
            toCreateNotes.length +
                toUpdateNotes.length +
                toDeleteNotes.length +
                twentyPercent +
                1,
            "anki",
        );
        await this.createNotes(toCreateNotes, failedCreated, ankiNoteManagers, syncNotificationObj);
        await this.updateNotes(toUpdateNotes, failedUpdated, ankiNoteManagers, syncNotificationObj);
        await this.deleteNotes(toDeleteNotes, failedDeleted, ankiNoteManagers, syncNotificationObj);
        await syncNotificationObj.updateMessage("Syncing logseq assets to anki...");
        await this.updateAssets(ankiNoteManagers);
        await syncNotificationObj.increment(twentyPercent);
        await AnkiConnect.invoke("reloadCollection", {});
        await syncNotificationObj.increment();
        window.parent.LogseqAnkiSync.dispatchEvent("syncLogseqToAnkiComplete");

        // Save logseq graph if any changes were made
        if (toCreateNotes.some((note) => !note.properties["id"])) {
            try {
                await window.parent.logseq.api.force_save_graph();
                await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (e) {
            }
        }

        // -- Show Result / Summery --
        let summery = `Sync Completed! \n Created Blocks: ${
            toCreateNotes.length - Object.keys(failedCreated).length
        } \n Updated Blocks: ${
            toUpdateNotes.length - Object.keys(failedUpdated).length
        } \n Deleted Blocks: ${
            toDeleteNotes.length - Object.keys(failedDeleted).length
        }`;
        if (Object.keys(failedCreated).length > 0)
            summery += `\nFailed Created: ${Object.keys(failedCreated).length} `;
        if (Object.keys(failedUpdated).length > 0)
            summery += `\nFailed Updated: ${Object.keys(failedUpdated).length} `;
        if (Object.keys(failedDeleted).length > 0)
            summery += `\nFailed Deleted: ${Object.keys(failedDeleted).length} `;

        console.log(toCreateNotes, toUpdateNotes, toDeleteNotes);
        // logseq.UI.showMsg(summery, status, {
        //     timeout: status == "success" ? 1200 : 4000,
        // });
        ActionNotification(
            [
                {
                    name: "View Details",
                    func: () => {
                        SyncResultDialog(
                            toCreateNotes,
                            toUpdateNotes,
                            toDeleteNotes,
                            failedCreated,
                            failedUpdated,
                            failedDeleted,
                        );
                    },
                },
            ],
            summery,
            20000,
            failedCreated.size > 0 || failedUpdated.size > 0 || failedDeleted.size > 0
                ? WARNING_ICON
                : SUCCESS_ICON,
        );
        console.log(summery);
        if (failedCreated.size > 0) console.log("\nFailed Created:", failedCreated);
        if (failedUpdated.size > 0) console.log("\nFailed Updated:", failedUpdated);
        if (failedDeleted.size > 0) console.log("\nFailed Deleted:", failedDeleted);
        console.log(
            "syncLogseqToAnki() Time Taken:",
            (performance.now() - start_time).toFixed(2),
            "ms",
        );
    }

    private async createNotes(
        toCreateNotes: Note[],
        failedCreated: { [key: string]: any },
        ankiNoteManagers: Map<string, LazyAnkiNoteManager>,
        syncNotificationObj: ProgressNotification,
    ): Promise<void> {
        for (const note of toCreateNotes) {
            try {
                const [html, assets, deck, breadcrumb, tags, extra, modelName, customFields] = await this.parseNote(
                    note,
                );

                // Get appropriate manager for this note's model
                const ankiNoteManager = ankiNoteManagers.get(modelName);
                if (!ankiNoteManager) {
                    throw new Error(`No manager found for model: ${modelName}`);
                }

                const dependencyHash = await NoteHashCalculator.getHash(note, [
                    html,
                    Array.from(assets),
                    deck,
                    breadcrumb,
                    tags,
                    extra,
                ]);
                // Add assets
                const graphPath = (await logseq.App.getCurrentGraph()).path;
                assets.forEach((asset) => {
                    ankiNoteManager.storeAsset(
                        path.basename(asset),
                        path.join(graphPath, path.resolve(asset)),
                    );
                });
                // Create note
                let fields: Record<string, string>;
                if (note.properties['ankiNoteType'] || note.properties['anki-note-type']) {
                    // Custom mode: use property-driven field mapping
                    fields = {
                        ...customFields,
                        "uuid-type": `${note.uuid}-${note.type}`,
                        uuid: note.uuid,
                        Text: html,
                        Extra: extra,
                        Breadcrumb: breadcrumb,
                        Config: JSON.stringify({
                            dependencyHash,
                            assets: [...assets],
                        }),
                    };
                } else {
                    // Legacy mode: use existing field structure
                    fields = {
                        "uuid-type": `${note.uuid}-${note.type}`,
                        uuid: note.uuid,
                        Text: html,
                        Extra: extra,
                        Breadcrumb: breadcrumb,
                        Config: JSON.stringify({
                            dependencyHash,
                            assets: [...assets],
                        }),
                    };
                }

                ankiNoteManager.addNote(
                    deck,
                    modelName,
                    fields,
                    tags,
                );
            } catch (e) {
                console.error(e);
                failedCreated[`${note.uuid}-${note.type}`] = e;
            }
            syncNotificationObj.increment();
        }

        // Execute addNotes for all managers
        for (const manager of ankiNoteManagers.values()) {
            let [addedNoteAnkiIdUUIDPairs, subOperationResults] = await manager.execute("addNotes");

            for (const addedNoteAnkiIdUUIDPair of addedNoteAnkiIdUUIDPairs) {
                // update ankiId of added blocks
                const uuidtype = addedNoteAnkiIdUUIDPair["uuid-type"];
                const uuid = uuidtype.split("-").slice(0, -1).join("-");
                const type = uuidtype.split("-").slice(-1)[0];
                const note = _.find(toCreateNotes, {uuid: uuid, type: type});
                if (note) {
                    note["ankiId"] = addedNoteAnkiIdUUIDPair["ankiId"];
                    console.log(note);
                }
            }

            for (const subOperationResult of subOperationResults) {
                if (subOperationResult != null && subOperationResult.error != null) {
                    console.log(subOperationResult.error);
                    failedCreated[subOperationResult["uuid-type"]] = subOperationResult.error;
                }
            }

            subOperationResults = await manager.execute("addNotes");
            for (const subOperationResult of subOperationResults) {
                if (subOperationResult != null && subOperationResult.error != null) {
                    console.error(subOperationResult.error);
                }
            }
        }
    }

    private async updateNotes(
        toUpdateNotes: Note[],
        failedUpdated: { [key: string]: any },
        ankiNoteManagers: Map<string, LazyAnkiNoteManager>,
        syncNotificationObj: ProgressNotification,
    ): Promise<void> {
        const graphPath = (await logseq.App.getCurrentGraph()).path;
        for (const note of toUpdateNotes) {
            try {
                // Use appropriate manager to get ankiId for custom note types
                const customModelName = note.properties['ankiNoteType'] || note.properties['anki-note-type'];
                const targetModelName = customModelName || this.modelName;
                const targetManager = ankiNoteManagers.get(targetModelName);

                let ankiId = null;
                if (targetManager) {
                    const filteredankiNotesArr = Array.from(targetManager.noteInfoMap.values()).filter(
                        (noteInfo) => noteInfo.fields["uuid-type"].value == `${note.uuid}-${note.type}`,
                    );
                    if (filteredankiNotesArr.length > 0) {
                        ankiId = parseInt(filteredankiNotesArr[0].noteId);
                    }
                }

                if (!ankiId) {
                    console.warn(`No ankiId found for note ${note.uuid}-${note.type}, skipping update`);
                    continue;
                }

                // Find the appropriate manager for this note
                const [html, assets, deck, breadcrumb, tags, extra, modelName, customFields] = await this.parseNote(note);
                const ankiNoteManager = ankiNoteManagers.get(modelName);
                if (!ankiNoteManager) {
                    throw new Error(`No manager found for model: ${modelName}`);
                }

                // Calculate Dependency Hash - It is the hash of all dependencies of the note
                // (dependencies include related logseq blocks, related logseq pages, plugin version, current note content in anki etc)
                const ankiNodeInfo = ankiNoteManager.noteInfoMap.get(ankiId);
                if (!ankiNodeInfo) {
                    console.warn(`No ankiNodeInfo found for ankiId ${ankiId}, skipping update`);
                    continue;
                }
                const oldConfig = ((configString) => {
                    try {
                        return JSON.parse(configString);
                    } catch (e) {
                        return {};
                    }
                })(ankiNodeInfo.fields.Config?.value || '{}');
                // Handle different field structures for custom vs legacy notes
                const oldHtml = ankiNodeInfo.fields.Text?.value || ankiNodeInfo.fields.front?.value || '';
                const oldBreadcrumb = ankiNodeInfo.fields.Breadcrumb?.value || '';
                const oldExtra = ankiNodeInfo.fields.Extra?.value || '';
                const [oldAssets, oldDeck, oldTags] = [
                    oldConfig.assets,
                    ankiNodeInfo.deck,
                    ankiNodeInfo.tags,
                ];
                let dependencyHash = await NoteHashCalculator.getHash(note, [
                    oldHtml,
                    oldAssets,
                    oldDeck,
                    oldBreadcrumb,
                    oldTags,
                    oldExtra,
                ]);
                if (
                    logseq.settings.skipOnDependencyHashMatch != true ||
                    oldConfig.dependencyHash != dependencyHash
                ) {
                    // Recalculate dependency hash with new content
                    dependencyHash = await NoteHashCalculator.getHash(note, [
                        html,
                        Array.from(assets),
                        deck,
                        breadcrumb,
                        tags,
                        extra,
                    ]);
                    // Add or update assets
                    const graphPath = (await logseq.App.getCurrentGraph()).path;
                    assets.forEach((asset) => {
                        ankiNoteManager.storeAsset(
                            path.basename(asset),
                            path.join(graphPath, path.resolve(asset)),
                        );
                    });
                    // Update note
                    if (logseq.settings.debug.includes("syncLogseqToAnki.ts"))
                        console.log(
                            `dependencyHash mismatch for note with id ${note.uuid}-${note.type}`,
                        );

                    let fields: Record<string, string>;
                    if (note.properties['ankiNoteType'] || note.properties['anki-note-type']) {
                        // Custom mode: use property-driven field mapping
                        fields = {
                            ...customFields,
                            "uuid-type": `${note.uuid}-${note.type}`,
                            uuid: note.uuid,
                            Text: html,
                            Extra: extra,
                            Breadcrumb: breadcrumb,
                            Config: JSON.stringify({
                                dependencyHash,
                                assets: [...assets],
                            }),
                        };
                    } else {
                        // Legacy mode: use existing field structure
                        fields = {
                            "uuid-type": `${note.uuid}-${note.type}`,
                            uuid: note.uuid,
                            Text: html,
                            Extra: extra,
                            Breadcrumb: breadcrumb,
                            Config: JSON.stringify({
                                dependencyHash,
                                assets: [...assets],
                            }),
                        };
                    }

                    ankiNoteManager.updateNote(
                        ankiId,
                        deck,
                        modelName,
                        fields,
                        tags,
                    );
                } else {
                    // Just update old assets
                    oldConfig.assets.forEach((asset) => {
                        if (ankiNoteManager.mediaInfo.has(path.basename(asset))) return;
                        ankiNoteManager.storeAsset(
                            path.basename(asset),
                            path.join(graphPath, path.resolve(asset)),
                        );
                    });
                }
            } catch (e) {
                console.error(e);
                failedUpdated[`${note.uuid}-${note.type}`] = e;
            }
            syncNotificationObj.increment();
        }

        // Execute updateNotes for all managers
        for (const manager of ankiNoteManagers.values()) {
            let subOperationResults = await manager.execute("updateNotes");
            for (const subOperationResult of subOperationResults) {
                if (subOperationResult != null && subOperationResult.error != null) {
                    console.error(subOperationResult.error);
                    failedUpdated[subOperationResult["uuid-type"]] = subOperationResult.error;
                }
            }
        }
    }

    private async updateAssets(
        ankiNoteManagers: Map<string, LazyAnkiNoteManager>
    ): Promise<void> {
        for (const manager of ankiNoteManagers.values()) {
            let subOperationResults = await manager.execute("storeAssets");
            for (const subOperationResult of subOperationResults) {
                if (subOperationResult != null && subOperationResult.error != null) {
                    console.error(subOperationResult.error);
                }
            }
        }
    }

    private async deleteNotes(
        toDeleteNotes: number[],
        failedDeleted : { [key: string]: any },
        ankiNoteManagers: Map<string, LazyAnkiNoteManager>,
        syncNotificationObj: ProgressNotification,
    ) {
        // Find which manager contains each note to delete
        for (const ankiId of toDeleteNotes) {
            let foundManager = null;
            for (const manager of ankiNoteManagers.values()) {
                if (manager.noteInfoMap.has(ankiId)) {
                    foundManager = manager;
                    break;
                }
            }
            if (foundManager) {
                foundManager.deleteNote(ankiId);
            }
            syncNotificationObj.increment();
        }

        // Execute deleteNotes for all managers
        for (const manager of ankiNoteManagers.values()) {
            const subOperationResults = await manager.execute("deleteNotes");
            for (const subOperationResult of subOperationResults) {
                if (subOperationResult != null && subOperationResult.error != null) {
                    console.error(subOperationResult.error);
                    failedDeleted[subOperationResult.error.ankiId] = subOperationResult.error;
                }
            }
        }
    }

    private async parseNote(
        note: Note,
    ): Promise<[string, Set<string>, string, string, string[], string, string, Record<string, string>]> {
        let {html, assets, tags} = await note.getClozedContentHTML();

        // Check for custom note type property
        const customModelName = note.properties['ankiNoteType'] || note.properties['anki-note-type'];
        let modelName = customModelName || this.modelName;
        let customFields: Record<string, string> = {};

        console.log('modelName', modelName);

        // If custom note type is specified, process all properties for field mapping
        if (customModelName) {
            // Process all properties for field mappings (except system properties)
            // Note: Block content will only be mapped if explicitly specified via properties
            for (const [key, value] of Object.entries(note.properties || {})) {
                // Skip system/reserved properties
                const systemProperties = [
                    'anki-note-type', 'ankinotetype',
                    'id', 'deck', 'tags', 'extra',
                    'template', 'disable-anki-sync', 'disableankisync',
                    'use-namespace-as-default-deck', 'usenamespaceasdefaultdeck'
                ];

                const keyLower = key.toLowerCase();
                if (systemProperties.some(prop => prop === keyLower)) {
                    continue;
                }

                // Convert property to field name - handle Logseq property normalization
                let fieldName = key;

                // Logseq normalizes camelCase properties to lowercase, so we need to convert back
                // Common patterns: archivedate -> archiveDate, testvalue -> testValue, etc.
                fieldName = this.convertToProperFieldName(key);

                // Handle array values (Logseq properties can be arrays)
                const rawContent = Array.isArray(value) ? value.join(', ') : value;

                // Special handling for block content mapping
                if (rawContent.toString() === '{{content}}') {
                    // Replace with actual block content
                    customFields[fieldName] = html;
                } else {
                    // Use raw content as-is (no HTML conversion for property values)
                    customFields[fieldName] = rawContent.toString();
                }

                console.log(`[Custom Fields] Mapped: "${key}" -> "${fieldName}" = "${customFields[fieldName]}"`);
            }

            console.log(`[Custom Mode] Final customFields:`, customFields);
        }

        if (logseq.settings.includeParentContent) {
            let newHtml = "";
            const parentBlocks = [];
            let parentID = (await LogseqProxy.Editor.getBlock(note.uuid)).parent.id;
            let parent;
            while ((parent = await LogseqProxy.Editor.getBlock(parentID)) != null) {
                parentBlocks.push({
                    content: escapeClozesAndMacroDelimiters(parent.content),
                    format: parent.format,
                    uuid: parent.uuid,
                    hiddenParent: (
                        await NoteUtils.matchTagNamesWithTagIds(
                            _.get(parent, "refs", []).map((ref) => ref.id),
                            ["hide-when-card-parent"],
                        )
                    ).includes("hide-when-card-parent") || Array.from(tags).includes("hide-all-card-parent"),
                    properties: parent.properties,
                });
                parentID = parent.parent.id;
            }
            for await (const parentBlock of parentBlocks.reverse()) {
                const parentBlockConverted = _.clone(
                    await convertToHTMLFile(parentBlock.content, parentBlock.format),
                );
                if (parentBlock.hiddenParent)
                    parentBlockConverted.html = `<span class="hidden-parent">${parentBlockConverted.html}</span>`;
                parentBlockConverted.assets.forEach((asset) => assets.add(asset));
                newHtml += `<ul class="children-list"><li class="children ${_.get(parentBlock, "properties['logseq.orderListType']") == "number" ? 'numbered' : ''}">
                                ${parentBlockConverted.html}`;
            }
            newHtml += `<ul class="children-list"><li class="children ${_.get(note, "properties['logseq.orderListType']") == "number" ? 'numbered' : ''}">
                            ${html}</li></ul>`;
            parentBlocks.reverse().forEach((parentBlock) => {
                newHtml += `</li></ul>`;
            });
            html = newHtml;
        }

        // Parse useNamespaceAsDefaultDeck value (based on https://github.com/debanjandhar12/logseq-anki-sync/pull/143)
        let useNamespaceAsDefaultDeck = null;
        try {
            let parentNamespaceID : number = note.page.id;
            while (parentNamespaceID != null) {
                let parentNamespacePage = await LogseqProxy.Editor.getPage(parentNamespaceID);
                if(!parentNamespacePage) break;
                if ([true, "true"].includes(getLogseqBlockPropSafe(parentNamespacePage, "properties.use-namespace-as-default-deck"))) {
                    useNamespaceAsDefaultDeck = true;
                    break;
                }
                else if ([false, "false"].includes(getLogseqBlockPropSafe(parentNamespacePage, "properties.use-namespace-as-default-deck"))) {
                    useNamespaceAsDefaultDeck = false;
                    break;
                }

                parentNamespaceID = _.get(parentNamespacePage, 'namespace.id', null);
            }
        } catch (e) {
            console.error(e);
        }
        if (useNamespaceAsDefaultDeck == null) useNamespaceAsDefaultDeck = logseq.settings.useNamespaceAsDefaultDeck;

        // Parse deck using logic described at https://github.com/debanjandhar12/logseq-anki-sync/wiki/How-to-set-or-change-the-deck-for-cards%3F
        let deck: any = null;
        try {
            let parentBlockUUID : string | number = note.uuid;
            while (parentBlockUUID != null) {
                const parentBlock = await LogseqProxy.Editor.getBlock(parentBlockUUID);
                if (getLogseqBlockPropSafe(parentBlock, "properties.deck") != null) {
                    deck = getLogseqBlockPropSafe(parentBlock, "properties.deck");
                    break;
                }
                parentBlockUUID = _.get(parentBlock, "parent.id", null);
            }
        } catch (e) { console.error(e); }

        if (deck === null) {
            try {
                let parentNamespaceID : number = note.page.id;
                while (parentNamespaceID != null) {
                    let parentNamespacePage = await LogseqProxy.Editor.getPage(parentNamespaceID);
                    if(!parentNamespacePage) break;
                    if (getLogseqBlockPropSafe(parentNamespacePage, "properties.deck") != null) {
                        deck = getLogseqBlockPropSafe(parentNamespacePage, "properties.deck");
                        break;
                    }
                    parentNamespaceID = _.get(parentNamespacePage, 'namespace.id', null);
                }
            } catch (e) { console.error(e); }
        }

        if (deck === null && useNamespaceAsDefaultDeck == true) {
            deck = splitNamespace(
                _.get(note, "page.originalName", "") ||
                _.get(note, "page.properties.title", ""),
            ).slice(0, -1).join("/");
        }

        deck = deck || logseq.settings.defaultDeck || "Default";

        if (typeof deck != "string") deck = deck[0];

        deck = splitNamespace(deck).join("::");

        // Parse breadcrumb
        let breadcrumb = `<a href="logseq://graph/${encodeURIComponent(
            this.graphName,
        )}?page=${encodeURIComponent(note.page.originalName)}" class="hidden">${
            note.page.originalName
        }</a>`;
        if (logseq.settings.breadcrumbDisplay.includes("Show Page name"))
            breadcrumb = `<a href="logseq://graph/${encodeURIComponent(
                this.graphName,
            )}?page=${encodeURIComponent(note.page.originalName)}" title="${
                note.page.originalName
            }">${note.page.originalName}</a>`;
        if (logseq.settings.breadcrumbDisplay == "Show Page name and parent blocks context") {
            try {
                const parentBlocks = [];
                let parentID = (await LogseqProxy.Editor.getBlock(note.uuid)).parent.id;
                let parentBlock : BlockEntity;
                while ((parentBlock = await LogseqProxy.Editor.getBlock(parentID)) != null) {
                    parentBlocks.push({
                        content: parentBlock.content
                            .replaceAll(MD_PROPERTIES_REGEXP, "")
                            .replaceAll(ANKI_CLOZE_REGEXP, "$3"),
                        uuid: parentBlock.uuid,
                    });
                    parentID = parentBlock.parent.id;
                }
                while (parentBlocks.length > 0) {
                    const parentBlock = parentBlocks.pop();
                    const parentBlockContentFirstLine = parentBlock.content.split("\n")[0];
                    breadcrumb += ` > <a href="logseq://graph/${encodeURIComponent(
                        this.graphName,
                    )}?block-id=${encodeURIComponent(parentBlock.uuid)}" title="${
                        parentBlock.content
                    }">${parentBlockContentFirstLine}</a>`;
                }
            } catch (e) {
                console.error(e);
            }
        }

        // Parse tags
        tags = [...Array.from(tags)];
        try {
            let parentBlockUUID : string | number = note.uuid;
            while (parentBlockUUID != null) {
                const parentBlock = await LogseqProxy.Editor.getBlock(parentBlockUUID);
                tags = [...tags, ...getCaseInsensitive(parentBlock, "properties.tags", [])];
                parentBlockUUID = _.get(parentBlock, "parent.id", null);
            }
        } catch (e) {
            console.error(e);
        }
        try {
            let parentNamespaceID : number = _.get(note, "page.id", null);
            while (parentNamespaceID != null) {
                const parentNamespacePage = await LogseqProxy.Editor.getPage(parentNamespaceID);
                tags = [...tags, ...getCaseInsensitive(parentNamespacePage, "properties.tags", [])];
                parentNamespaceID = _.get(parentNamespacePage, "namespace.id", null);
            }
        } catch (e) {
            console.error(e);
        }
        tags = tags.map((tag) => tag.replace(/\//g, "::"));
        tags = tags.map((tag) => tag.replace(/\s/g, "_")); // Anki doesn't like spaces in tags
        tags = _.uniq(tags);
        tags = tags.filter((tag) => {
            const otherTags = (tags as string[]).filter((otherTag) => otherTag != tag);
            const otherTagsStartingWithThisName = otherTags.filter((otherTag) =>
                otherTag.startsWith(tag + "::"),
            );
            return otherTagsStartingWithThisName.length == 0;
        });

        let extra =
            _.get(note, "properties.extra") || _.get(note, "page.properties.extra") || "";
        if (Array.isArray(extra)) extra = extra.join(" ");
        extra = await convertToHTMLFile(
            extra,
            (await LogseqProxy.Editor.getBlock(note.uuid)).format,
        );
        assets = new Set([...assets, ...extra.assets]);
        extra = extra.html;

        return [html, assets, deck, breadcrumb, tags, extra, modelName, customFields];
    }

    // Helper function to convert Logseq normalized property names back to proper Anki field names
    private convertToProperFieldName(property: string): string {
        // Common field name mappings - add more as needed
        const fieldMappings: Record<string, string> = {
            'archivedate': 'archiveDate',
            'testvalue': 'testValue',
            'createddate': 'createdDate',
            'modifieddate': 'modifiedDate',
            'sourcepage': 'sourcePage',
            'extrainfo': 'extraInfo',
            // Add more mappings as needed
        };

        // Check for exact match first
        if (fieldMappings[property]) {
            return fieldMappings[property];
        }

        // If no mapping found, try to auto-convert common patterns
        // Pattern: word1word2 -> word1Word2
        if (property.length > 6 && property.includes('date')) {
            return property.replace(/date$/, 'Date');
        }

        if (property.length > 6 && property.includes('value')) {
            return property.replace(/value$/, 'Value');
        }

        // Default: return as-is
        return property;
    }
}
