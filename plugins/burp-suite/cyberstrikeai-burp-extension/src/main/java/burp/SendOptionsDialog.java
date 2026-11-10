package burp;

import javax.swing.*;
import java.awt.*;
import java.util.List;

/**
 * Per-request send dialog: project, role, agent mode, and custom instruction.
 */
final class SendOptionsDialog {
    private SendOptionsDialog() {}

    static final class Result {
        final String instruction;
        final String projectId;
        final String role;
        final JamesLeeAIClient.AgentMode agentMode;

        Result(String instruction, String projectId, String role, JamesLeeAIClient.AgentMode agentMode) {
            this.instruction = instruction;
            this.projectId = projectId == null ? "" : projectId;
            this.role = role == null ? "" : role;
            this.agentMode = agentMode;
        }
    }

    private static String lastProjectId = "";
    private static String lastRole = "";
    private static JamesLeeAIClient.AgentMode lastAgentMode = null;

    static Result show(
            Component parent,
            JamesLeeAIClient client,
            JamesLeeAIClient.Config cfg,
            String token,
            String defaultInstruction
    ) {
        JamesLeeAIClient.AgentMode defaultMode = lastAgentMode != null
                ? lastAgentMode
                : JamesLeeAIClient.AgentMode.EINO_SINGLE;

        JPanel panel = new JPanel(new BorderLayout(0, 10));
        panel.setBorder(BorderFactory.createEmptyBorder(4, 4, 0, 4));

        JPanel selectors = new JPanel(new GridBagLayout());
        GridBagConstraints gc = new GridBagConstraints();
        gc.insets = new Insets(4, 6, 4, 6);
        gc.fill = GridBagConstraints.HORIZONTAL;
        gc.weighty = 0;

        JComboBox<JamesLeeAIClient.ProjectOption> projectBox = new JComboBox<>();
        projectBox.addItem(new JamesLeeAIClient.ProjectOption("", "加载中..."));
        projectBox.setEnabled(false);

        JComboBox<JamesLeeAIClient.RoleOption> roleBox = new JComboBox<>();
        roleBox.addItem(new JamesLeeAIClient.RoleOption("", "加载中..."));
        roleBox.setEnabled(false);

        JComboBox<JamesLeeAIClient.AgentMode> agentBox = new JComboBox<>(JamesLeeAIClient.AgentMode.values());
        agentBox.setSelectedItem(defaultMode);
        agentBox.setRenderer(new DefaultListCellRenderer() {
            @Override
            public Component getListCellRendererComponent(JList<?> list, Object value, int index, boolean isSelected, boolean cellHasFocus) {
                super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus);
                if (value instanceof JamesLeeAIClient.AgentMode) {
                    setText(((JamesLeeAIClient.AgentMode) value).displayName);
                }
                return this;
            }
        });

        // Row 0: labels — 项目 | 角色 | 对话
        gc.gridy = 0;
        gc.weightx = 1.0;

        gc.gridx = 0;
        selectors.add(new JLabel("项目"), gc);
        gc.gridx = 1;
        selectors.add(new JLabel("角色"), gc);
        gc.gridx = 2;
        selectors.add(new JLabel("对话"), gc);

        // Row 1: dropdowns
        gc.gridy = 1;

        gc.gridx = 0;
        selectors.add(projectBox, gc);
        gc.gridx = 1;
        selectors.add(roleBox, gc);
        gc.gridx = 2;
        selectors.add(agentBox, gc);

        JTextArea editor = new JTextArea(
                defaultInstruction == null || defaultInstruction.trim().isEmpty()
                        ? HttpMessageFormatter.defaultInstruction()
                        : defaultInstruction,
                7,
                70
        );
        editor.setLineWrap(true);
        editor.setWrapStyleWord(true);
        editor.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 13));

        JPanel instructionPanel = new JPanel(new BorderLayout(0, 6));
        instructionPanel.add(new JLabel("测试指令（可针对当前流量修改）："), BorderLayout.NORTH);
        instructionPanel.add(new JScrollPane(editor), BorderLayout.CENTER);

        panel.add(selectors, BorderLayout.NORTH);
        panel.add(instructionPanel, BorderLayout.CENTER);

        Thread loader = new Thread(() -> {
            try {
                List<JamesLeeAIClient.ProjectOption> projects = client.fetchProjects(cfg, token);
                List<JamesLeeAIClient.RoleOption> roles = client.fetchRoles(cfg, token);
                SwingUtilities.invokeLater(() -> populateProjects(projectBox, projects, lastProjectId));
                SwingUtilities.invokeLater(() -> populateRoles(roleBox, roles, lastRole));
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> {
                    projectBox.removeAllItems();
                    projectBox.addItem(new JamesLeeAIClient.ProjectOption("", "(加载失败)"));
                    projectBox.setEnabled(true);
                    roleBox.removeAllItems();
                    roleBox.addItem(new JamesLeeAIClient.RoleOption("", "默认"));
                    roleBox.setEnabled(true);
                    JOptionPane.showMessageDialog(parent,
                            "加载项目/角色失败: " + ex.getMessage(),
                            "JamesLeeAI", JOptionPane.WARNING_MESSAGE);
                });
            }
        }, "JamesLeeAI-LoadCatalog");
        loader.start();

        int result = JOptionPane.showConfirmDialog(
                parent,
                panel,
                "发送到 JamesLeeAI",
                JOptionPane.OK_CANCEL_OPTION,
                JOptionPane.PLAIN_MESSAGE
        );
        if (result != JOptionPane.OK_OPTION) {
            return null;
        }

        JamesLeeAIClient.ProjectOption project = (JamesLeeAIClient.ProjectOption) projectBox.getSelectedItem();
        JamesLeeAIClient.RoleOption role = (JamesLeeAIClient.RoleOption) roleBox.getSelectedItem();
        JamesLeeAIClient.AgentMode agentMode = (JamesLeeAIClient.AgentMode) agentBox.getSelectedItem();
        if (agentMode == null) {
            agentMode = defaultMode;
        }

        String instruction = editor.getText();
        if (instruction == null || instruction.trim().isEmpty()) {
            instruction = HttpMessageFormatter.defaultInstruction();
        } else {
            instruction = instruction.trim();
        }

        lastProjectId = project != null ? project.id : "";
        lastRole = role != null ? role.name : "";
        lastAgentMode = agentMode;

        return new Result(instruction, lastProjectId, lastRole, agentMode);
    }

    private static void populateProjects(JComboBox<JamesLeeAIClient.ProjectOption> box,
                                         List<JamesLeeAIClient.ProjectOption> items,
                                         String selectId) {
        box.removeAllItems();
        for (JamesLeeAIClient.ProjectOption item : items) {
            box.addItem(item);
        }
        selectComboById(box, selectId);
        box.setEnabled(true);
    }

    private static void populateRoles(JComboBox<JamesLeeAIClient.RoleOption> box,
                                      List<JamesLeeAIClient.RoleOption> items,
                                      String selectName) {
        box.removeAllItems();
        for (JamesLeeAIClient.RoleOption item : items) {
            box.addItem(item);
        }
        selectComboByName(box, selectName);
        box.setEnabled(true);
    }

    private static void selectComboById(JComboBox<JamesLeeAIClient.ProjectOption> box, String id) {
        if (id == null) id = "";
        for (int i = 0; i < box.getItemCount(); i++) {
            JamesLeeAIClient.ProjectOption item = box.getItemAt(i);
            if (item != null && id.equals(item.id)) {
                box.setSelectedIndex(i);
                return;
            }
        }
        box.setSelectedIndex(0);
    }

    private static void selectComboByName(JComboBox<JamesLeeAIClient.RoleOption> box, String name) {
        if (name == null) name = "";
        for (int i = 0; i < box.getItemCount(); i++) {
            JamesLeeAIClient.RoleOption item = box.getItemAt(i);
            if (item != null && name.equals(item.name)) {
                box.setSelectedIndex(i);
                return;
            }
        }
        box.setSelectedIndex(0);
    }
}
