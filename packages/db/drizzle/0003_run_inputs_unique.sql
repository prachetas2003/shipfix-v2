CREATE UNIQUE INDEX IF NOT EXISTS "run_inputs_run_question_unique" ON "run_inputs" USING btree ("run_id","question_id");
