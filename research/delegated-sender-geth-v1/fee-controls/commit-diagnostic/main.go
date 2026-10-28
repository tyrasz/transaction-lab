// Two fresh-state persistence controls. No VM or transaction is executed.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/tracing"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/tests"
	"github.com/holiman/uint256"
)

type control struct {
	Name       string             `json:"name"`
	Allocation types.GenesisAlloc `json:"allocation"`
}
type input struct {
	Fork        string         `json:"fork"`
	Coinbase    common.Address `json:"coinbase"`
	BlockNumber hexutil.Uint64 `json:"blockNumber"`
	Timestamp   hexutil.Uint64 `json:"timestamp"`
	Controls    []control      `json:"controls"`
}
type row struct {
	Name               string  `json:"name"`
	BeforeRoot         string  `json:"beforeRoot"`
	BeforeSlot         string  `json:"beforeSlot"`
	IntermediateRoot   string  `json:"intermediateRoot"`
	CommitRoot         string  `json:"commitRoot"`
	CommitError        *string `json:"commitError"`
	AccountExistsAfter bool    `json:"accountExistsAfter"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("one input path required")
	}
	f, err := os.Open(os.Args[1])
	if err != nil {
		return err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 1024*1024))
	decoder.DisallowUnknownFields()
	var in input
	if err = decoder.Decode(&in); err != nil {
		return err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return fmt.Errorf("trailing input")
	}
	if in.Fork != "Osaka" || len(in.Controls) != 2 || in.Controls[0].Name != "original_nonempty_storage" || in.Controls[1].Name != "only_coinbase_storage_empty" {
		return fmt.Errorf("foreign controls")
	}
	config, _, err := tests.GetChainConfig(in.Fork)
	if err != nil {
		return err
	}
	rules := config.Rules(new(big.Int).SetUint64(uint64(in.BlockNumber)), true, uint64(in.Timestamp))
	if !rules.IsCancun || !rules.IsEIP158 {
		return fmt.Errorf("incorrect deletion rules")
	}
	rows := make([]row, 0, 2)
	for _, c := range in.Controls {
		st := tests.MakePreState(rawdb.NewMemoryDatabase(), c.Allocation, false, rawdb.HashScheme)
		r := row{Name: c.Name, BeforeRoot: st.StateDB.IntermediateRoot(rules).Hex(), BeforeSlot: st.StateDB.GetState(in.Coinbase, common.BigToHash(big.NewInt(991))).Hex()}
		st.StateDB.AddBalance(in.Coinbase, new(uint256.Int), tracing.BalanceChangeUnspecified)
		r.IntermediateRoot = st.StateDB.IntermediateRoot(rules).Hex()
		r.AccountExistsAfter = st.StateDB.Exist(in.Coinbase)
		root, commitErr := st.StateDB.Commit(rules, uint64(in.BlockNumber))
		r.CommitRoot = root.Hex()
		if commitErr != nil {
			s := commitErr.Error()
			r.CommitError = &s
		}
		st.Close()
		rows = append(rows, r)
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Rows []row `json:"rows"`
	}{rows})
}
