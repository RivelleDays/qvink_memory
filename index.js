import { getStringHash, debounce, waitUntilCondition, extractAllWords, isTrueBoolean } from '../../../utils.js';
import { getContext, getApiUrl, extension_settings, doExtrasFetch, modules, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    activateSendButtons,
    deactivateSendButtons,
    animation_duration,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    is_send_press,
    saveSettingsDebounced,
    substituteParamsExtended,
    generateRaw,
    getMaxContextSize,
    setExtensionPrompt,
    streamingProcessor,
} from '../../../../script.js';
import { is_group_generating, selected_group } from '../../../group-chats.js';
import { loadMovingUIState } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { getTextTokens, getTokenCount, tokenizers } from '../../../tokenizers.js';
import { debounce_timeout } from '../../../constants.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { MacrosParser } from '../../../macros.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
export { MODULE_NAME };

// THe module name modifies where settings are stored, where information is stored on message objects, macros, etc.
const MODULE_NAME = 'qvink_memory';
const MODULE_DIR = `scripts/extensions/third-party/${MODULE_NAME}`;
const MODULE_NAME_FANCY = 'Qvink Memory';

const long_memory_macro = `${MODULE_NAME}_long_memory`;
const short_memory_macro = `${MODULE_NAME}_short_memory`;


const defaultPrompt = `Summarize the given fictional narrative in a single, very short and concise statement of fact.
State only events that will need to be remembered in the future.
Include names when possible.
Response must be in the past tense.
Maintain the same point of view as the text (i.e. if the text uses "you", use "your" in the response). If an observer is unspecified, assume it is "you".
Your response must ONLY contain the summary. If there is nothing worth summarizing, do not respond.`;
const default_long_template = `[Following is a list of events that occurred in the past]:\n{{${long_memory_macro}}}`
const default_short_template = `[Following is a list of recent events]:\n{{${short_memory_macro}}}`

const defaultSettings = {
    auto_summarize: true,   // whether to automatically summarize chat messages
    include_world_info: false,  // include world info in context when summarizing
    prompt: defaultPrompt,
    long_template: default_long_template,
    short_template: default_short_template,
    block_chat: false,  // block input when summarizing
    message_length_threshold: 10,  // minimum message token length for summarization
    summary_maximum_length: 20,  // maximum token length of the summary
    include_user_messages: false,  // include user messages in summarization
    include_names: false,  // include sender names in summary prompt
    debug_mode: false,  // enable debug mode

    long_term_context_limit: 0.1,  // percentage of context size to use as long-term memory limit
    short_term_context_limit: 0.1,  // percentage of context size to use as short-term memory limit

    long_term_position: extension_prompt_types.IN_PROMPT,
    long_term_role: extension_prompt_roles.SYSTEM,
    long_term_depth: 2,
    long_term_scan: false,

    short_term_position: extension_prompt_types.IN_PROMPT,
    short_term_depth: 2,
    short_term_role: extension_prompt_roles.SYSTEM,
    short_term_scan: false,
};



// Utility functions
function log(message) {
    console.log(`[${MODULE_NAME_FANCY}]`, message);
}
function debug(message) {
    if (get_settings('debug_mode')) {
        log("[DEBUG] "+message);
    }
}
function error(message) {
    log("[ERROR] "+message);
}

const saveChatDebounced = debounce(() => getContext().saveChat(), debounce_timeout.relaxed);

function initialize_settings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || defaultSettings;
}
function set_settings(key, value) {
    extension_settings[MODULE_NAME][key] = value;
    saveSettingsDebounced();
    debug(`Setting [${key}] updated to [${value}]`);
}
function get_settings(key) {
    return extension_settings[MODULE_NAME]?.[key] ?? defaultSettings[key];
}

function count_tokens(text, padding = 0) {
    return getTokenCount(text, padding);
}
function get_context_size() {
    return getMaxContextSize();
}
function get_long_token_limit() {
    let long_term_context_limit = get_settings('long_term_context_limit');
    let context_size = get_context_size();
    return Math.floor(context_size * long_term_context_limit);
}
function get_short_token_limit() {
    let short_term_context_limit = get_settings('short_term_context_limit');
    let context_size = get_context_size();
    return Math.floor(context_size * short_term_context_limit);
}


/**
 * Bind a UI element to a setting.
 * @param selector {string} jQuery Selector for the UI element
 * @param key {string} Key of the setting
 * @param type {string} Type of the setting (number, boolean, etc)
 */
function bind_setting(selector, key, type=null) {
    let element = $(selector);

    // if no elements found, log error
    if (element.length === 0) {
        log(`Error: No element found for selector [${selector}] for setting [${key}]`);
        return;
    }

    // detect if it's a text area
    let trigger = 'change';

    // If a textarea, every keypress triggers an update
    if (element.is('textarea')) {
        trigger = 'input';
    }

    // detect if it's a radio button group
    let radio = false
    if (element.is('input[type="radio"]')) {
        trigger = 'change';
        radio = true;
    }

    // get the setting value
    let setting_value = get_settings(key);

    // initialize the UI element with the setting value
    if (radio) {  // if a radio group, check the one that matches the setting value
        let selected = element.filter(`[value="${setting_value}"]`)
        if (selected.length === 0) {
            error(`Error: No radio button found for value [${setting_value}] for setting [${key}]`);
            return;
        }
        selected.prop('checked', true);
    } else {  // otherwise, set the value directly
        if (type === 'boolean') {
            element.prop('checked', setting_value);
        } else {
            element.val(setting_value);
        }
    }

    // Make the UI element update the setting when changed
    element.on(trigger, function (event) {
        let value;
        if (type === 'number') {
            value = Number($(this).val());
        } else if (type === 'boolean') {
            value = Boolean($(this).prop('checked'));
        } else {
            value = $(this).val();
        }

        set_settings(key, value)

        // refresh memory state
        refresh_memory_debounced();
    });

    // trigger the change event to update the setting once
    element.trigger(trigger);
}
function bind_function(id, func) {
    // bind a function to an element
    let element = $(id);
    if (element.length === 0) {
        log(`Error: No element found for selector [${id}]`);
        return;
    }

    // check if it's an input element, and bind a "change" event if so
    if (element.is('input')) {
        element.on('change', function (event) {
            func(event);
        });
    } else {  // otherwise, bind a "click" event
        element.on('click', function (event) {
            func(event);
        });
    }
}


// UI functions
function set_memory_display(text='') {
    let display = $('#memory_display');
    display.val(text);
    display.scrollTop(display[0].scrollHeight);
}
function on_restore_prompt_click() {
    $('#prompt').val(defaultPrompt).trigger('input');
}

function update_message_visuals() {
    // Update the message divs according to memory status
    let global_class = `${MODULE_NAME}_item`;
    let short_memory_class = `${MODULE_NAME}_short_memory`;
    let long_memory_class = `${MODULE_NAME}_long_memory`;

    let short_div = `<div class="${global_class}">Short-term Memory</div>`;
    let long_div = `<div class="${global_class}">Long-term Memory</div>`;
    let remember_div = `<div class="${global_class}">Remembered</div>`;

    let chat = getContext().chat;
    for (let i=chat.length-1; i >= 0; i--) {
        let message = chat[i];
        let include = get_memory(message, 'include');
        let error = get_memory(message, 'error');
        let remember = get_memory(message, 'remember');

        // it will have an attribute "mesid" that is the message index
        let div_element = $(`div[mesid="${i}"]`);
        if (div_element.length === 0) {
            error(`Could not find message element for message ${i} while updating message visuals`);
            continue;
        }

        // remove any existing memory divs
        div_element.find(`div.${global_class}`).remove();

        // if it's not marked for inclusion, skip
        if (!include) {
            continue;
        }

        // get the name container class=ch_name
        let name_element = div_element.find('div.ch_name');
        let name_child = name_element.children().first();

        // if there was an error, mark it as such
        if (error) {
            name_child.after(`<div class="${global_class}">Error: ${error}</div>`);
            continue;
        }

        // place a new div right after the first child element of the name element
        if (include === 'short') {
            name_child.after(short_div);
        } else if (include === 'long') {
            name_child.after(long_div);
        }

        if (remember) {
            name_child.after(remember_div);
        }

    }
}

// Memory functions
function store_memory(message, key, value) {
    // store information on the message object
    if (!message.extra) {
        message.extra = {};
    }
    if (!message.extra[MODULE_NAME]) {
        message.extra[MODULE_NAME] = {};
    }

    message.extra[MODULE_NAME][key] = value;
    saveChatDebounced();
}
function get_memory(message, key) {
    // get information from the message object
    return message.extra?.[MODULE_NAME]?.[key];
}

function remember_message(index=null) {
    // Set a message to be remembered as long-term memory
    let context = getContext();

    // Default to the last message, min 0
    index = Math.max(index ?? context.chat.length-1, 0)

    // Mark it as remembered
    let message = context.chat[index]
    store_memory(message, 'remember', true);
    log(`Set message ${index} to be remembered in long-term memory`);
}


// Inclusion / Exclusion criteria
function check_message_exclusion(message) {
    // check for any exclusion criteria for a given message

    // first check if it has been marked to be remembered by the user - if so, it bypasses all exclusion criteria
    if (get_memory(message, 'remember')) {
        return true;
    }

    // check if it's a user message
    if (!get_settings('include_user_messages') && message.is_user) {
        return false
    }

    // check if it's a system (hidden) message
    if (message.is_system) {
        return false;
    }

    // Check if the message is too short
    let token_size = count_tokens(message.mes);
    if (token_size < get_settings('message_length_threshold')) {
        return false
    }

    return true;
}
function text_within_short_limit(text) {
    // check if the text is within the short-term memory size
    let short_term_context_limit = get_settings('short_term_context_limit');
    let context_size = get_context_size();
    let token_limit = context_size * short_term_context_limit;
    let token_size = count_tokens(text);
    return token_size <= token_limit;
}
function text_within_long_limit(text) {
    // check if the text is within the long-term memory size
    let long_term_context_limit = get_settings('long_term_context_limit');
    let context_size = get_context_size();
    let token_limit = context_size * long_term_context_limit;
    let token_size = count_tokens(text);
    return token_size <= token_limit;
}

function update_message_inclusion_flags() {
    // Update all messages in the chat, flagging them as short-term or long-term memories to include in the injection.
    log("Updating message inclusion flags...")
    let context = getContext();
    let chat = context.chat;

    // iterate through the chat in reverse order and mark the messages that should be included in short-term memory
    let short_limit_reached = false;
    let long_limit_reached = false;
    let end = chat.length - 1;
    for (let i = end; i >= 0; i--) {
        let message = chat[i];

        // check for any of the exclusion criteria
        let include = check_message_exclusion(message)
        if (!include) {
            store_memory(message, 'include', null);
            continue;
        }

        // if it doesn't have a memory on it, don't include it
        if (!get_memory(message, 'memory')) {
            store_memory(message, 'include', null);
            error(`Message ${i} does not have a summary, excluding it from memory injection.`);
            continue;
        }

        if (!short_limit_reached) {  // short-term limit hasn't been reached yet
            store_memory(message, 'include', 'short');  // mark the message as short-term

            // check short-term memory limit
            let short_memory_text = get_short_memory(i, end);
            if (!text_within_short_limit(short_memory_text)) {
                short_limit_reached = true;
            }
            continue
        }

        // if the short-term limit has been reached, check the long-term limit

        let remember = get_memory(message, 'remember');
        if (!long_limit_reached && remember) {  // long-term limit hasn't been reached yet and the message was marked to be remembered
            store_memory(message, 'include', 'long');  // mark the message as long-term

            // check long-term memory limit
            let long_memory_text = get_long_memory(i, end);
            if (!text_within_long_limit(long_memory_text)) {
                long_limit_reached = true;
            }
            continue
        }

        // if we haven't marked it for inclusion yet, mark it as excluded
        store_memory(message, 'include', null);
    }

    update_message_visuals();  // update the message visuals accordingly
}


// Summarization
async function summarize_text(text) {
    text = ` ${get_settings('prompt')}\n\nText to Summarize:\n${text}`;

    // get size of text
    let token_size = count_tokens(text);
    debug(`Summarizing text with ${token_size} tokens...`)

    let context_size = get_context_size();
    if (token_size > context_size) {
        error(`Text ${token_size} exceeds context size ${context_size}.`);
    }

    let include_world_info = get_settings('include_world_info');
    if (include_world_info) {
        /**
         * Background generation based on the provided prompt.
         * @param {string} quiet_prompt Instruction prompt for the AI
         * @param {boolean} quietToLoud Whether the message should be sent in a foreground (loud) or background (quiet) mode
         * @param {boolean} skipWIAN whether to skip addition of World Info and Author's Note into the prompt
         * @param {string} quietImage Image to use for the quiet prompt
         * @param {string} quietName Name to use for the quiet prompt (defaults to "System:")
         * @param {number} [responseLength] Maximum response length. If unset, the global default value is used.
         * @returns
         */
        return await generateQuietPrompt(text, false, false, '', '', get_settings('summary_maximum_length'));
    } else {
        /**
         * Generates a message using the provided prompt.
         * @param {string} prompt Prompt to generate a message from
         * @param {string} api API to use. Main API is used if not specified.
         * @param {boolean} instructOverride true to override instruct mode, false to use the default value
         * @param {boolean} quietToLoud true to generate a message in system mode, false to generate a message in character mode
         * @param {string} [systemPrompt] System prompt to use. Only Instruct mode or OpenAI.
         * @param {number} [responseLength] Maximum response length. If unset, the global default value is used.
         * @returns {Promise<string>} Generated message
         */
        return await generateRaw(text, '', false, false, '', get_settings('summary_maximum_length'));
    }
}

/**
 * Summarize a message and save the summary to the message object.
 * @param index {number|null} Index of the message to summarize (default last message)
 * @param replace {boolean} Whether to replace existing summaries (default false)
 */
async function summarize_message(index=null, replace=false) {
    let context = getContext();

    // Default to the last message, min 0
    index = Math.max(index ?? context.chat.length - 1, 0)
    let message = context.chat[index]
    let message_hash = getStringHash(message.mes);

    // check message exclusion criteria first
    if (!await check_message_exclusion(message)) {
        return;
    }

    // If we aren't forcing replacement, check if the message already has a summary and the hash hasn't changed since last summarization
    if (!replace && get_memory(message, 'memory') && get_memory(message, 'hash') === message_hash) {
        debug(`Message ${index} already has a summary and hasn't changed since, skipping summarization.`);
        return;
    }

    // summarize it
    debug(`Summarizing message ${index}...`)
    let text = message.mes;

    // Add the sender name to the prompt if enabled
    if (get_settings('include_names')) {
        text = `[${message.name}]:\n${text}`;
    }

    let summary = await summarize_text(text)
    store_memory(message, 'memory', summary);
    store_memory(message, 'hash', message_hash);  // store the hash of the message that we just summarized
    debug("Message summarized: " + summary)
    if (!summary) {  // generation failed
        error(`Failed to summarize message ${index} - generation failed.`);
        store_memory(message, 'error', "Failed");  // clear the memory if generation failed
    }

}

/**
 * Given an index range, concatenate the summaries and return the result.
 * @param start {number} Start index (default 0)
 * @param end {number|null} End index (default second-to-last message)
 * @param long_term {boolean} Whether to include only long-term memories (default false)
 * @param short_term {boolean} Whether to include only short-term memories (default false)
 * @returns {string} Concatenated summaries
 * Note 1: messages are still subject to the exclusion criteria checked by check_message_exclusion()
 */
function concatenate_summaries(start, end=null, long_term=false, short_term=false) {
    let context = getContext();

    // Default start is 0
    start = Math.max(start ?? 0, 0)

    // Default end is the second-to-last message
    end = Math.max(end ?? context.chat.length - 1, 0)

    // assert start is less than end
    if (start > end) {
        error('Cannot concatenate summaries: start index is greater than end index');
        return '';
    }

    // iterate through the chat in reverse order and collect the summaries
    let summaries = [];
    for (let i = end; i >= start; i--) {
        let message = context.chat[i];

        // check against the message exclusion criteria
        if (!check_message_exclusion(message)) {
            continue;
        }

        let inclusion = get_memory(message, 'include');
        if ((inclusion === 'short' && short_term) || (inclusion === 'long' && long_term)) {
            let memory = get_memory(message, 'memory');
            if (memory) {  // add the summary for this message if it exists
                summaries.push(memory);
            } else {
                error(`Message ${i} does not have a summary, but is marked for inclusion ${inclusion}`);
            }
        }
    }

    // Reverse the summaries (since we iterated in reverse order)
    summaries.reverse();

    // Add an asterisk to the beginning of each summary and join them with newlines
    summaries = summaries.map((s) => `* ${s}`);
    return summaries.join('\n');
}
function get_long_memory(start=0, end=null) {
    // get the injection text for long-term memory
    return concatenate_summaries(start, end, true, false);
}
function get_short_memory(start=0, end=null) {
    // get the injection text for short-term memory
    return concatenate_summaries(start, end, false, true);
}


/** Update the current memory prompt and display */
function refresh_memory() {
    // regenerate the memory prompt to inject, and update the memory display
    update_message_inclusion_flags()  // update the inclusion flags for all messages
    let long_memory = get_long_memory();
    let short_memory = get_short_memory();

    let long_template = get_settings('long_template')
    let short_template = get_settings('short_template')

    let long_injection = substituteParamsExtended(long_template, { [long_memory_macro]: long_memory });
    let short_injection = substituteParamsExtended(short_template, { [short_memory_macro]: short_memory });

    setExtensionPrompt(`${MODULE_NAME}_long`,  long_injection,  get_settings('long_term_position'), get_settings('long_term_depth'), get_settings('long_term_scan'), get_settings('long_term_role'));
    setExtensionPrompt(`${MODULE_NAME}_short`, short_injection, get_settings('short_term_position'), get_settings('short_term_depth'), get_settings('short_term_scan'), get_settings('short_term_role'));

    set_memory_display(`${long_injection}\n\n${short_injection}`)  // update the memory display
}
const refresh_memory_debounced = debounce(refresh_memory, debounce_timeout.relaxed);

/**
 * Perform summarization on the entire chat, optionally replacing existing summaries.
 * @param replace {boolean} Whether to replace existing summaries (default false)
 */
async function summarize_chat(replace=false) {
    log('Summarizing chat...')
    let context = getContext();

    // optionally block user from sending chat messages while summarization is in progress
    if (get_settings('block_chat')) {
        deactivateSendButtons();
    }

    for (let i = 0; i < context.chat.length; i++) {
        await summarize_message(i, replace);
    }

    if (get_settings('block_chat')) {
        activateSendButtons();
    }
    log('Chat summarized')
    refresh_memory()
}


// Event handling
async function onChatEvent(event=null) {
    // When the chat is updated, check if the summarization should be triggered
    debug("Chat updated, checking if summarization should be triggered... "+event)

    // if auto-summarize is not enabled, skip
    if (!get_settings('auto_summarize')) {
        debug("Automatic summarization is disabled.");
        return;
    }

    const context = getContext();

    // no characters or group selected
    if (!context.groupId && context.characterId === undefined) {
        return;
    }

    // Streaming in-progress
    if (streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    switch (event) {
        case 'chat_changed':  // Chat or character changed
            debug('Chat or character changed');
            refresh_memory();
            break;
        case 'message_deleted':  // message was deleted
            debug("Message deleted, refreshing memory")
            refresh_memory();
            break;
        case 'new_message':  // New message detected
            debug("New message detected, summarizing")
            await summarize_chat(false);  // summarize the chat, but don't replace existing summaries
            break;
        case 'message_edited':  // Message has been edited
            debug("Message edited, summarizing")
            await summarize_chat(false);  // summarize the chat, but don't replace existing summaries UNLESS they changed since last summarization
            break;
        case 'message_swiped':  // when this event occurs, don't do anything (a new_message event will follow)
            debug("Message swiped, reloading memory")
            refresh_memory()
            break;
        default:
            debug("Unknown event, refreshing memory")
            refresh_memory();
    }
}

// UI handling
function setupListeners() {
    debug("Setting up listeners...")

    bind_function('#prompt_restore', on_restore_prompt_click);
    bind_function('#popout_button', (e) => {
        do_popout(e);
        e.stopPropagation();
    })
    bind_function('#rerun_memory', async (e) => {
        set_memory_display("Loading...");  // clear the memory display
        await summarize_chat(true);  // rerun summarization, replacing existing summaries
        refresh_memory();  // refresh the memory (and the display) when finished
    })
    bind_function('#refresh_memory', (e) => {
        refresh_memory();  // refresh memory (and the display)
    })

    bind_setting('#auto_summarize', 'auto_summarize', 'boolean');
    bind_setting('#include_world_info', 'include_world_info', 'boolean');
    bind_setting('#block_chat', 'block_chat', 'boolean');
    bind_setting('#prompt', 'prompt');
    bind_setting('#include_user_messages', 'include_user_messages', 'boolean');
    bind_setting('#include_names', 'include_names', 'boolean');
    bind_setting('#message_length_threshold', 'message_length_threshold', 'number');
    bind_setting('#summary_maximum_length', 'summary_maximum_length', 'number');
    bind_setting('#debug_mode', 'debug_mode', 'boolean');

    bind_setting('#long_template', 'long_template');
    bind_setting('#long_term_context_limit', 'long_term_context_limit', 'number');
    bind_setting('input[name="long_term_position"]', 'long_term_position');
    bind_setting('#long_term_depth', 'long_term_depth', 'number');
    bind_setting('#long_term_role', 'long_term_role');
    bind_setting('#long_term_scan', 'long_term_scan', 'boolean');

    bind_setting('#short_template', 'short_template');
    bind_setting('#short_term_context_limit', 'short_term_context_limit', 'number');
    bind_setting('input[name="short_term_position"]', 'short_term_position');
    bind_setting('#short_term_depth', 'short_term_depth', 'number');
    bind_setting('#short_term_role', 'short_term_role');
    bind_setting('#short_term_scan', 'short_term_scan', 'boolean');

    // update the displayed token limit when the input changes
    // Has to happen after the bind_setting calls, so changing the input sets the setting, then updates the display
    bind_function('#long_term_context_limit', () => {
        $('#long_term_context_limit_display').text(get_long_token_limit());
    })
    bind_function('#short_term_context_limit', () => {
        $('#short_term_context_limit_display').text(get_short_token_limit());
    })
    $('#long_term_context_limit').trigger('change');  // trigger the change event once to update the display at start
    $('#short_term_context_limit').trigger('change');
}

function do_popout(e) {
    // popout the memory display
    const target = e.target;


    if ($('#qmExtensionPopout').length === 1) {  // Already open - close it
        debug('saw existing popout, removing');
        $('#qmExtensionPopout').fadeOut(animation_duration, () => { $('#qmExtensionPopoutClose').trigger('click'); });
        return
    }

    // repurposes the zoomed avatar template to server as a floating div
    debug('did not see popout yet, creating');
    const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
    const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
    const template = $('#zoomed_avatar_template').html();
    const controlBarHtml = `<div class="panelControlBar flex-container">
    <div id="qmExtensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
    <div id="qmExtensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
    </div>`;
    const newElement = $(template);
    newElement.attr('id', 'qmExtensionPopout')
        .removeClass('zoomed_avatar')
        .addClass('draggable')
        .empty();
    originalElement.empty();
    originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
    newElement.append(controlBarHtml).append(originalHTMLClone);
    $('body').append(newElement);
    $('#drawer_content').addClass('scrollableInnerFull');
    setupListeners();
    loadMovingUIState();

    $('#qmExtensionPopout').fadeIn(animation_duration);
    dragElement(newElement);

    //setup listener for close button to restore extensions menu
    $('#qmExtensionPopoutClose').off('click').on('click', function () {
        $('#drawer_content').removeClass('scrollableInnerFull');
        const summaryPopoutHTML = $('#drawer_content');
        $('#qmExtensionPopout').fadeOut(animation_duration, () => {
            originalElement.empty();
            originalElement.html(summaryPopoutHTML);
            $('#qmExtensionPopout').remove();
        });
    });
}

// Entry point
jQuery(async function () {
    log(`Loading extension...`)

    // Load settings
    initialize_settings();

    // Set up UI
    $("#extensions_settings2").append(await $.get(`${MODULE_DIR}/settings.html`));  // load html
    setupListeners();  // setup UI listeners

    // Event listeners
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => onChatEvent('new_message'));
    eventSource.on(event_types.MESSAGE_DELETED, () => onChatEvent('message_deleted'));
    eventSource.on(event_types.MESSAGE_EDITED, () => onChatEvent('message_edited'));
    eventSource.on(event_types.MESSAGE_SWIPED,() => onChatEvent('message_swiped'));
    eventSource.on(event_types.CHAT_CHANGED, () => onChatEvent('chat_changed'));

    // Slash commands
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'remember',
        callback: (args) => {
            remember_message(args.index);
        },
        helpString: 'Mark the latest chat message as a long-term memory',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                name: 'index',
                description: 'Index of the message to remember',
                isRequired: false,
                typeList: ARGUMENT_TYPE.NUMBER,
            }),
        ],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'initialize_memory',
        callback: (args) => {
            summarize_chat(args.replace);
        },
        helpString: 'Summarize all chat messages',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'replace',
                description: 'Replace existing summaries',
                isRequired: false,
                typeList: ARGUMENT_TYPE.BOOLEAN,
            }),
        ],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'log_chat',
        callback: (args) => {
            log("CHAT: ")
            log(getContext().chat)
        },
        helpString: 'log chat',
    }));

    // Macros
    MacrosParser.registerMacro(short_memory_macro, () => get_short_memory());
    MacrosParser.registerMacro(long_memory_macro, () => get_long_memory());
});
