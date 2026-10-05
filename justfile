model := "gemma-4-12b-it-mlx-bench@6bit"

# レシピの一覧を表示する
default:
    @just --list

# 依存パッケージ（TypeScript）を入れる
install:
    pnpm install

# 型を検査する（.claude-plugin/types はエンジンが mod を読み込むたびに書き出す）
typecheck:
    pnpm typecheck

# エンジンと同じ読み方でマニフェストと hooks モジュールを検査する
validate:
    claude plugin validate .

# claude-code/testing のテストを実行する
test:
    claude plugin test .

# コミット前の検査をまとめて実行する
check: typecheck validate test

# LM Studio のサーバを起動し、検出に使う Gemma 4 を読み込む
gemma:
    ~/.lmstudio/bin/lms server start
    ~/.lmstudio/bin/lms load "{{ model }}" -y

# この mod を読み込んだ Claude Code を起動する
run *args:
    claude --plugin-dir {{ justfile_directory() }} {{ args }}

# DiffusionGemma を mlx-vlm で起動する（LM Studio は未対応。重みが無ければ約 15GB をダウンロードする）。Metal の打ち切りを減らすため 1 件ずつ・小さな単位で GPU に送る
diffusion:
    MLX_MAX_OPS_PER_BUFFER=8 MLX_MAX_MB_PER_BUFFER=200 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 uvx --from mlx-vlm==0.7.4 mlx_vlm.server --model mlx-community/diffusiongemma-26B-A4B-it-4bit --host 127.0.0.1 --port 8090 --max-num-seqs 1

# 検出器を DiffusionGemma に切り替えて Claude Code を起動する
run-diffusion *args:
    claude --plugin-dir {{ justfile_directory() }} --settings '{"pluginConfigs":{"privacy-gateway@inline":{"options":{"gemmaUrl":"http://127.0.0.1:8090/v1/chat/completions","gemmaModel":"mlx-community/diffusiongemma-26B-A4B-it-4bit"}}}}' {{ args }}
