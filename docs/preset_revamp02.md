Hi! We must implement a "preset" system for the `AstroEX` commands that rely on LLM API calls (`jobCloth`, `jobJudge`, and `makeMaterials`). The intention is to maximize ease of use and consolidate all settings into a single location (`./config/presets.json`).

A preset name will be invoked on the CLI via the `--preset` flag. Only one preset can be invoked at a time for a given running command.

Each "preset" is literally a set of configuration items (`name`, `provider`, `base_url`, `modelId`, `promptTemplate`, `temperature`, `top_p`, and `max_tokens`) that a particular command can use to quickly configure itself for use. Whenever an LLM API calling command starts, the `./config/presets.json` file should be dynamically loaded, populating the help page, and preparing for usage with the command.

THe `promptTemplates` live in `./prompts/` within the codebase.

Our universal system prompt is the Veritas System Prompt, located at `./sysprompts/veritas_sys_prompt.txt`. **Its content must be the only content placed in the system message of the payload. All other prompt template data must be placed in the user message of the payload.**

Additionally, it is critical that placeholders within prompt templates are accurately replaced with the necessary data. For example, `{myKeySkills}` must be replaced with the contents of `./prompts/my_key_skills.txt` in accordance with the template's layout, etc.

Please ensure that `jobCloth`, `jobJudge`, and `makeMaterials` are optimally modified to manage this new "preset" system.

Thank you!

**Please do not modify any of the below configuration or associated prompt templates without explicit persmission from the user!**

``` ./config/presets.json
{
  "jobCloth": {
    "jc_oai-gpt-oss-120b": {
      "name": "jc_oai-gpt-oss-120b",
      "provider": "cerebras",
      "base_url": "https://api.cerebras.ai/v1",
      "modelId": "gpt-oss-120b",
      "promptTemplate": "./prompts/jc_oai-gpt-oss-120b.txt",
      "temperature": 0.45,
      "topP": 0.95,
      "maxTokens": 8000
    },
    "jc_qwen-3-235b-a22b-instruct-2507": {
      "name": "jc_qwen-3-235b-a22b-instruct-2507",
      "provider": "cerebras",
      "base_url": "https://api.cerebras.ai/v1",
      "modelId": "qwen-3-235b-a22b-instruct-2507",
      "promptTemplate": "./prompts/jc_qwen-3-235b-a22b-instruct-2507.txt",
      "temperature": 0.6,
      "topP": 0.95,
      "maxTokens": 8000
    },
    "jc_mai-ds-r1": {
      "name": "jc_mai-ds-r1",
      "provider": "openrouter",
      "base_url": "https://openrouter.ai/api/v1",
      "modelId": "microsoft/mai-ds-r1:free",
      "promptTemplate": "./prompts/jc_mai-ds-r1.txt",
      "temperature": 0.60,
      "topP": 0.95,
      "maxTokens": 8000
    }
  },
  "jobJudge": {
    "jep_oai-gpt-oss-120b": {
      "name": "jep_oai-gpt-oss-120b",
      "provider": "cerebras",
      "base_url": "https://api.cerebras.ai/v1",
      "modelId": "gpt-oss-120b",
      "promptTemplate": "./prompts/jep_oai-gpt-oss-120b.txt",
      "temperature": 0.45,
      "topP": 0.95,
      "maxTokens": 8000
    },
    "jep_ds-v3-0324": {
      "name": "jep_ds-v3-0324",
      "provider": "openrouter",
      "base_url": "https://openrouter.ai/api/v1",
      "modelId": "deepseek/deepseek-chat-v3-0324:free",
      "promptTemplate": "./prompts/jep_ds-v3-0324.txt",
      "temperature": 0.60,
      "topP": 0.95,
      "maxTokens": 8000
    },
    "jep_gas-gf2.0t": {
      "name": "jep_gas-gf2.0t",
      "provider": "gemini",
      "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
      "modelId": "gemini-2.0-flash-thinking-exp-01-21",
      "promptTemplate": "./prompts/jep_gas-gf2.0t.txt",
      "temperature": 0.45,
      "topP": 0.95,
      "maxTokens": 8000
    },
    "jep_mai-ds-r1": {
      "name": "jep_mai-ds-r1",
      "provider": "openrouter",
      "base_url": "https://openrouter.ai/api/v1",
      "modelId": "microsoft/mai-ds-r1:free",
      "promptTemplate": "./prompts/jep_mai-ds-r1.txt",
      "temperature": 0.60,
      "topP": 0.95,
      "maxTokens": 8000
    }
  },
  "makeMaterials": {
    "rop_oai-g5m": {
      "name": "rop_oai-g5m",
      "provider": "openrouter",
      "base_url": "https://openrouter.ai/api/v1",
      "modelId": "openai/gpt-5-mini",
      "promptTemplate": "./prompts/rop_oai-g5m.txt",
      "temperature": 0.6,
      "topP": 0.95,
      "maxTokens": 8000
    },
    "rop_z-glma": {
      "name": "rop_z-glma",
      "provider": "openrouter",
      "base_url": "https://openrouter.ai/api/v1",
      "modelId": "z-ai/glm-4.5-air:free",
      "promptTemplate": "./prompts/rop_z-glma.txt",
      "temperature": 0.6,
      "topP": 0.95,
      "maxTokens": 16000
    },
    "rop_a-cs4": {
      "name": "rop_a-cs4",
      "provider": "openrouter",
      "base_url": "https://openrouter.ai/api/v1",
      "modelId": "anthropic/claude-sonnet-4",
      "promptTemplate": "./prompts/rop_a-cs4.txt",
      "temperature": 1.0,
      "topP": 1.0,
      "maxTokens": 16000
    },
    "rop_ds-v3-0324": {
      "name": "rop_ds-v3-0324",
      "provider": "openrouter",
      "base_url": "https://openrouter.ai/api/v1",
      "modelId": "deepseek/deepseek-chat-v3-0324:free",
      "promptTemplate": "./prompts/rop_ds-v3-0324.txt",
      "temperature": 0.60,
      "topP": 0.95,
      "maxTokens": 8000
    },
    "rop_m-l_01": {
      "name": "rop_m-l_01",
      "provider": "mistral",
      "base_url": "https://api.mistral.ai/v1",
      "modelId": "mistral-large-latest",
      "promptTemplate": "./prompts/rop_m-l_01.txt",
      "temperature": 0.7,
      "topP": 0.95,
      "maxTokens": 8000
    }
  }
}
```

* Prompt Templates: `./prompts/`
* System Prompt: `./sysprompts/veritas_sys_prompt.txt`

**Please do not modify any of the below configuration or associated prompt templates without explicit persmission from the user!**
