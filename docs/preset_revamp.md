# Preset System Documentation

**Version**: 3.4.1
**Last Updated**: 2025-09-20

## Overview

We're totally revamping the LLM API calling commands within `AstroEX`: `jobCloth`, `jobJudge`, and `makeMaterials`

### New Feature: Max-Tokens CLI Override (v3.2.4)

In version 3.2.4, we've enhanced the preset system to support CLI `--max-tokens` argument override functionality. CLI arguments now take precedence over preset values, providing maximum flexibility for users.

**Override Priority**: CLI → Preset → Default (8000)

Going forward, the below defined commands will have their functionality driven by the below "presets" which are to be stored in an external configuration file. All command/preset parameters should remain overridable on the CLI, but the presets will be the primary method of use.

Our universal system prompt is the Veritas System Prompt, located at `./sysprompts/veritas_sys_prompt.txt`. **Its content must be the only content placed in the system message of the payload. All other prompt template data must be placed in the user message of the payload.**

Additionally, it is critical that placeholders within prompt templates are accurately replaced with the necessary data. For example, `{myKeySkills}` must be replaced with the contents of `./prompts/my_key_skills.txt` in accordance with the template's layout, etc.

**Please do not modify any of the below prompt templates!**

* Command: jobCloth (`jc` presets)
    Preset Name: jc_oai-gpt-oss-120b
        Provider: cerebras
        Model ID: gpt-oss-120b
        Prompt Template: ./prompts/jc_oai-gpt-oss-120b.txt
        Temperature: 0.45
        Top_P: 0.95
        Max_Tokens: 8000
    Preset Name: qwen-3-235b-a22b-instruct-2507
        Provider: cerebras
        Model ID: qwen-3-235b-a22b-instruct-2507
        Prompt Template: ./prompts/jc_qwen-3-235b-a22b-instruct-2507.txt
        Temperature: 0.6
        Top_P: 0.95
        Max_Tokens: 8000
    Preset Name: jc_mai-ds-r1
        Provider: openrouter
        Model ID: microsoft/mai-ds-r1:free
        Prompt Template: ./prompts/jc_mai-ds-r1.txt
        Temperature: 0.60
        Top_P: 0.95
        Max_Tokens: 8000
* Command: jobJudge (`jep` presets)
    Present Name: jep_oai-gpt-oss-120b
        Provider: cerebras
        Model ID: gpt-oss-120b
        Prompt Template: ./prompts/jep_oai-gpt-oss-120b.txt
        Temperature: 0.45
        Top_P: 0.95
        Max_Tokens: 8000
    Preset Name: jep_ds-v3-0324
        Provider: openrouter
        Model ID: deepseek/deepseek-chat-v3-0324:free
        Prompt Template: ./prompts/jep_ds-v3-0324.txt
        Temperature: 0.60
        Top_P: 0.95
        Max_Tokens: 8000
    Preset Name: jep_gas-gf2.0t
        Provider: Gemini
        Model ID: gemini-2.0-flash-thinking-exp-01-21
        Prompt Template: ./prompts/jep_gas-gf2.0t.txt
        Temperature: 0.45
        Top_P: 0.95
        Max_Tokens: 8000
    Preset Name: jep_mai-ds-r1
        Provider: openrouter
        Model ID: microsoft/mai-ds-r1:free
        Prompt Template: ./prompts/jep_mai-ds-r1.txt
        Temperature: 0.60
        Top_P: 0.95
        Max_Tokens: 8000
* Command: makeMaterials (`rop` presets)
    Preset Name: rop_oai-g5m
        Provider: openrouter
        Model ID: openai/gpt-5-mini
        Prompt Template: ./prompts/rop_oai-g5m.txt
        Temperature: 0.6
        Top_P: 0.95
        Max_Tokens: 8000
    Preset Name: rop_z-glma
        Provider: openrouter
        Model ID: z-ai/glm-4.5-air:free
        Prompt Template: ./prompts/rop_z-glma.txt
        Temperature: 0.6
        Top_P: 0.95
        Max_Tokens: 16000
    Preset Name: rop_a-cs4
        Provider: openrouter
        Model ID: anthropic/claude-sonnet-4
        Prompt Template: ./prompts/rop_a-cs4.txt
        Temperature: 1.0
        Top_P: 1.0
        Max_Tokens: 16000
    Preset Name: rop_ds-v3-0324
        Provider: openrouter
        Model ID: deepseek/deepseek-chat-v3-0324:free
        Prompt Template: ./prompts/rop_ds-v3-0324.txt
        Temperature: 0.60
        Top_P: 0.95
        Max_Tokens: 8000
    Preset Name: rop_m-l_01
        Provider: Mistral
        Model ID: mistral-large-latest
        Prompt Template: ./prompts/rop_m-l_01.txt
        Temperature: 0.7
        Top_P: 0.95
        Max_Tokens: 8000
* Template Placeholders
        jep_vars = {
          "targJD": targJD,
          "myResume": my_resume.txt,
          "myTestimonials": my_testimonials.txt
        }
        rop_vars = {
          "myProfessionalTitle": my_professional_title.txt,
          "myProfessionalSummary": my_professional_summary.txt,
          "myKeySkills": my_key_skills.txt,
          "targJD": targJD,
          "myResume": my_resume.txt,
          "myTestimonials": my_testimonials.txt,
          "cover_length": cover_length
        }
* Prompt Templates: `./prompts/`
* System Prompts: `./sysprompts/`

**Please do not modify any of the above prompt templates!**
