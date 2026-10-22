// REQ-DISC-016 — agentless NFS export enumeration with the MOUNT protocol (RFC 1813 appendix I):
// ask rpcbind (RFC 1833, program 100000 v2) where MOUNT v3 (program 100005) listens over TCP, then
// call EXPORT (procedure 5) and decode the export list with its client groups. ONC RPC and XDR are
// small enough to encode by hand here; no third-party RPC library is needed, and the same call works
// for Linux knfsd, NetApp ONTAP, Dell PowerScale and every other NFSv3 server.
package nas

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

const (
	rpcbindPort     = 111
	rpcVersion      = 2
	rpcCall         = 0
	rpcReply        = 1
	rpcMsgAccepted  = 0
	rpcSuccess      = 0
	rpcAuthNull     = 0
	rpcbindProgram  = 100000
	rpcbindVersion  = 2
	rpcbindGetPort  = 3
	mountProgram    = 100005
	mountVersion    = 3
	mountExportProc = 5
	ipprotoTCP      = 6
	xdrWord         = 4
	recordLastFlag  = 0x80000000
	recordLenMask   = 0x7fffffff
	maxReplyBytes   = 4 << 20
	rpcTimeout      = 15 * time.Second
	// A deterministic transaction id is fine: the stream carries one call at a time.
	xidGetPort = 0x4f4d4150 // "OMAP"
	xidExport  = 0x4f4d4151
)

// Export is one NFS export with the clients allowed to mount it.
type Export struct {
	Path   string
	Groups []string
}

type xdrWriter struct{ buf []byte }

func (w *xdrWriter) uint32(v uint32) {
	w.buf = binary.BigEndian.AppendUint32(w.buf, v)
}

func (w *xdrWriter) opaque(b []byte) {
	w.uint32(uint32(len(b)))
	w.buf = append(w.buf, b...)
	for len(w.buf)%xdrWord != 0 {
		w.buf = append(w.buf, 0)
	}
}

type xdrReader struct {
	buf []byte
	pos int
}

func (r *xdrReader) uint32() (uint32, error) {
	if r.pos+xdrWord > len(r.buf) {
		return 0, io.ErrUnexpectedEOF
	}
	v := binary.BigEndian.Uint32(r.buf[r.pos:])
	r.pos += xdrWord
	return v, nil
}

func (r *xdrReader) str() (string, error) {
	n, err := r.uint32()
	if err != nil {
		return "", err
	}
	padded := int(n) + (xdrWord-int(n)%xdrWord)%xdrWord
	if r.pos+padded > len(r.buf) {
		return "", io.ErrUnexpectedEOF
	}
	s := string(r.buf[r.pos : r.pos+int(n)])
	r.pos += padded
	return s, nil
}

// callHeader writes an RPC CALL header with AUTH_NULL credentials and verifier.
func callHeader(w *xdrWriter, xid, program, version, procedure uint32) {
	w.uint32(xid)
	w.uint32(rpcCall)
	w.uint32(rpcVersion)
	w.uint32(program)
	w.uint32(version)
	w.uint32(procedure)
	w.uint32(rpcAuthNull)
	w.uint32(0)
	w.uint32(rpcAuthNull)
	w.uint32(0)
}

// roundTrip sends one record-marked RPC call and returns the reply body after the accepted-reply header.
func roundTrip(ctx context.Context, address string, body []byte, xid uint32) ([]byte, error) {
	dialer := net.Dialer{Timeout: rpcTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > rpcTimeout {
		deadline = time.Now().Add(rpcTimeout)
	}
	_ = conn.SetDeadline(deadline)
	frame := binary.BigEndian.AppendUint32(nil, uint32(len(body))|recordLastFlag)
	frame = append(frame, body...)
	if _, err := conn.Write(frame); err != nil {
		return nil, err
	}
	var reply []byte
	for {
		var head [xdrWord]byte
		if _, err := io.ReadFull(conn, head[:]); err != nil {
			return nil, err
		}
		marker := binary.BigEndian.Uint32(head[:])
		size := int(marker & recordLenMask)
		if len(reply)+size > maxReplyBytes {
			return nil, errors.New("rpc reply exceeds the size limit")
		}
		chunk := make([]byte, size)
		if _, err := io.ReadFull(conn, chunk); err != nil {
			return nil, err
		}
		reply = append(reply, chunk...)
		if marker&recordLastFlag != 0 {
			break
		}
	}
	r := &xdrReader{buf: reply}
	gotXid, err := r.uint32()
	if err != nil {
		return nil, err
	}
	if gotXid != xid {
		return nil, fmt.Errorf("rpc reply xid %d does not match call %d", gotXid, xid)
	}
	msgType, _ := r.uint32()
	if msgType != rpcReply {
		return nil, errors.New("rpc reply has the wrong message type")
	}
	replyState, _ := r.uint32()
	if replyState != rpcMsgAccepted {
		return nil, errors.New("rpc call was denied")
	}
	// verifier (flavor + opaque body)
	if _, err := r.uint32(); err != nil {
		return nil, err
	}
	if _, err := r.str(); err != nil {
		return nil, err
	}
	acceptState, err := r.uint32()
	if err != nil {
		return nil, err
	}
	if acceptState != rpcSuccess {
		return nil, fmt.Errorf("rpc call accepted with status %d", acceptState)
	}
	return reply[r.pos:], nil
}

// MountPort asks rpcbind on the host for the TCP port of MOUNT v3; 0 means the program is not registered.
func MountPort(ctx context.Context, host string, portmapPort int) (int, error) {
	w := &xdrWriter{}
	callHeader(w, xidGetPort, rpcbindProgram, rpcbindVersion, rpcbindGetPort)
	w.uint32(mountProgram)
	w.uint32(mountVersion)
	w.uint32(ipprotoTCP)
	w.uint32(0)
	body, err := roundTrip(ctx, net.JoinHostPort(host, strconv.Itoa(portmapPort)), w.buf, xidGetPort)
	if err != nil {
		return 0, err
	}
	r := &xdrReader{buf: body}
	port, err := r.uint32()
	if err != nil {
		return 0, err
	}
	return int(port), nil
}

// Exports calls MOUNT v3 EXPORT and decodes the linked list of exports and groups.
func Exports(ctx context.Context, host string, mountPort int) ([]Export, error) {
	w := &xdrWriter{}
	callHeader(w, xidExport, mountProgram, mountVersion, mountExportProc)
	body, err := roundTrip(ctx, net.JoinHostPort(host, strconv.Itoa(mountPort)), w.buf, xidExport)
	if err != nil {
		return nil, err
	}
	r := &xdrReader{buf: body}
	var out []Export
	for {
		more, err := r.uint32()
		if err != nil {
			return nil, err
		}
		if more == 0 {
			break
		}
		path, err := r.str()
		if err != nil {
			return nil, err
		}
		e := Export{Path: path, Groups: []string{}}
		for {
			hasGroup, err := r.uint32()
			if err != nil {
				return nil, err
			}
			if hasGroup == 0 {
				break
			}
			g, err := r.str()
			if err != nil {
				return nil, err
			}
			e.Groups = append(e.Groups, g)
		}
		out = append(out, e)
	}
	return out, nil
}

// Rpcbind is the default portmapper port when the job does not override it.
func Rpcbind(options map[string]any) int {
	switch v := options[optionPortmap].(type) {
	case int:
		if v > 0 {
			return v
		}
	case float64:
		if v > 0 {
			return int(v)
		}
	}
	return rpcbindPort
}
